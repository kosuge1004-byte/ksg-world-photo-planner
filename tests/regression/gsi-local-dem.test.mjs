import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
import { lookupGsiElevations } from "../../server/gsiElevation.ts";
import {
  LOCAL_DEM_MANIFEST_KEY,
  LOCAL_DEM_NO_DATA_CENTIMETERS,
  decodeLocalDemAsset,
  encodeLocalDemAsset,
  heightFromLocalDemAsset,
  heightFromLocalDemAssetSet,
  localDemAssetKey,
  localDemBytesToArrayBuffer,
  localDemMeshBounds,
  localDemMeshCode,
  lookupLocalDemElevationsForSource,
  resetLocalDemRuntimeCacheForTests,
} from "../../server/gsiLocalDem.ts";
import {
  decodeGsiDemXml,
  parseGsiDemGml,
} from "../../scripts/prepare-gsi-dem-r2-assets.mjs";

const south = 35.416666667;
const west = 134.5;
const north = 35.425;
const east = 134.5125;

function planeAsset(width = 8, height = 8) {
  const values = new Int32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) values[y * width + x] = (x + y * 10) * 100;
  }
  return {
    width,
    height,
    south,
    west,
    north,
    east,
    latitudeStep: (north - south) / height,
    longitudeStep: (east - west) / width,
    heightsCentimeters: values,
  };
}

test("GML decoder honors official Shift_JIS declarations without replacement characters", () => {
  const bytes = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><value>', "ascii"),
    // その他 in Windows-compatible Shift_JIS.
    Buffer.from([0x82, 0xbb, 0x82, 0xcc, 0x91, 0xbc]),
    Buffer.from("</value>", "ascii"),
  ]);
  const decoded = decodeGsiDemXml(bytes, "old-dem5.xml");
  assert.equal(decoded.encoding, "Shift_JIS");
  assert.match(decoded.xml, /<value>その他<\/value>/);
  assert.doesNotMatch(decoded.xml, /\uFFFD/);
});

test("GML decoder rejects undeclared encodings and malformed declared bytes", () => {
  assert.throws(
    () => decodeGsiDemXml(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><x/>', "ascii")),
    /宣言文字コードに対応していません/
  );
  assert.throws(
    () => decodeGsiDemXml(Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><x>', "ascii"),
      Buffer.from([0x82]),
    ])),
    /正しいデータではありません/
  );
});

function coordinateForGrid(asset, gridX, gridY) {
  return {
    latitude: asset.north - (gridY + 0.5) * asset.latitudeStep,
    longitude: asset.west + (gridX + 0.5) * asset.longitudeStep,
  };
}

function constantMeshAsset(meshCode, valueCentimeters, width = 4, height = 4) {
  const bounds = localDemMeshBounds(meshCode);
  assert.ok(bounds);
  return {
    width,
    height,
    ...bounds,
    latitudeStep: (bounds.north - bounds.south) / height,
    longitudeStep: (bounds.east - bounds.west) / width,
    heightsCentimeters: new Int32Array(width * height).fill(valueCentimeters),
  };
}

test("JIS mesh keys match downloaded DEM mesh names", () => {
  assert.equal(localDemMeshCode("DEM5A", 35.42, 134.505), "53341400");
  assert.equal(localDemMeshCode("DEM10B", 35.42, 134.505), "533414");
  assert.equal(
    localDemAssetKey("DEM5A", "53341400"),
    "gsi-local-dem-v1/DEM5A/53341400.bin.gz"
  );
});

test("binary GML grid format round-trips centimetres and NoData through gzip", () => {
  const input = planeAsset();
  input.heightsCentimeters[7] = LOCAL_DEM_NO_DATA_CENTIMETERS;
  const compressed = gzipSync(new Uint8Array(encodeLocalDemAsset(input)));
  const decoded = decodeLocalDemAsset(compressed);
  assert.deepEqual(
    [...decoded.heightsCentimeters],
    [...input.heightsCentimeters]
  );
  assert.equal(decoded.latitudeStep, input.latitudeStep);
  assert.equal(decoded.longitudeStep, input.longitudeStep);
});

test("native-grid bilinear and constrained bicubic preserve a planar surface", () => {
  const asset = planeAsset();
  const query = coordinateForGrid(asset, 3.25, 3.5);
  const expected = 3.25 + 3.5 * 10;
  assert.ok(Math.abs(
    heightFromLocalDemAsset(asset, query.latitude, query.longitude, "bilinear") - expected
  ) < 1e-9);
  assert.ok(Math.abs(
    heightFromLocalDemAsset(asset, query.latitude, query.longitude, "constrained-bicubic", "neutral") - expected
  ) < 1e-9);

  // Bicubic requires a true 4x4 neighborhood. At a GML mesh edge it must hand
  // the point back to the existing tile path rather than duplicate an edge cell.
  const edge = coordinateForGrid(asset, 0.25, 0.25);
  assert.equal(
    heightFromLocalDemAsset(asset, edge.latitude, edge.longitude, "constrained-bicubic", "neutral"),
    null
  );
});

test("native-grid bilinear interpolation uses the true adjacent GML mesh", () => {
  const westMesh = "53341400";
  const eastMesh = "53341401";
  const westAsset = constantMeshAsset(westMesh, 1_000);
  const eastAsset = constantMeshAsset(eastMesh, 2_000);
  const latitude = (westAsset.south + westAsset.north) / 2;
  const longitude = westAsset.east;
  const assets = new Map([
    [westMesh, westAsset],
    [eastMesh, eastAsset],
  ]);

  assert.equal(localDemMeshCode("DEM5A", latitude, longitude), eastMesh);
  assert.equal(
    heightFromLocalDemAsset(eastAsset, latitude, longitude, "bilinear"),
    null,
    "a single mesh must not duplicate its west edge"
  );
  assert.ok(Math.abs(
    heightFromLocalDemAssetSet("DEM5A", assets, latitude, longitude, "bilinear") - 15
  ) < 1e-9);
});

test("GML parser honors +x-y, cell-centre spacing and numeric -9999 NoData", () => {
  const tuples = [
    "地表面,1.00", "その他,-9999.", "地表面,3.00",
    "地表面,4.00", "地表面,5.00", "地表面,6.00",
    "地表面,7.00", "地表面,8.00", "地表面,9.00",
  ].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM>
  <mesh>53341400</mesh><coverage><gml:boundedBy><gml:Envelope>
  <gml:lowerCorner>35.416666667 134.5</gml:lowerCorner>
  <gml:upperCorner>35.425 134.5125</gml:upperCorner>
  </gml:Envelope></gml:boundedBy><gml:gridDomain><gml:Grid><gml:limits><gml:GridEnvelope>
  <gml:low>0 0</gml:low><gml:high>2 2</gml:high>
  </gml:GridEnvelope></gml:limits></gml:Grid></gml:gridDomain>
  <gml:rangeSet><gml:DataBlock><gml:tupleList>${tuples}</gml:tupleList></gml:DataBlock></gml:rangeSet>
  <gml:coverageFunction><gml:GridFunction><gml:sequenceRule order="+x-y">Linear</gml:sequenceRule>
  <gml:startPoint>0 0</gml:startPoint></gml:GridFunction></gml:coverageFunction>
  </coverage></DEM></Dataset>`;
  const parsed = parseGsiDemGml(xml, "FG-GML-53341400-DEM5A-test.xml");
  assert.equal(parsed.source, "DEM5A");
  assert.equal(parsed.tupleCount, 9);
  assert.deepEqual([...parsed.asset.heightsCentimeters], [
    100, LOCAL_DEM_NO_DATA_CENTIMETERS, 300,
    400, 500, 600,
    700, 800, 900,
  ]);
});

test("GML parser preserves omitted prefix and suffix cells as NoData for sparse GSI coverage", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM>
  <mesh>53341400</mesh><coverage><gml:boundedBy><gml:Envelope>
  <gml:lowerCorner>35.416666667 134.5</gml:lowerCorner>
  <gml:upperCorner>35.425 134.5125</gml:upperCorner>
  </gml:Envelope></gml:boundedBy><gml:gridDomain><gml:Grid><gml:limits><gml:GridEnvelope>
  <gml:low>0 0</gml:low><gml:high>3 2</gml:high>
  </gml:GridEnvelope></gml:limits></gml:Grid></gml:gridDomain>
  <gml:rangeSet><gml:DataBlock><gml:tupleList>
  その他,1.25
  その他,2.50
  データなし,-9999.
  その他,4.75
  </gml:tupleList></gml:DataBlock></gml:rangeSet>
  <gml:coverageFunction><gml:GridFunction><gml:sequenceRule order="+x-y">Linear</gml:sequenceRule>
  <gml:startPoint>1 0</gml:startPoint></gml:GridFunction></gml:coverageFunction>
  </coverage></DEM></Dataset>`;
  const parsed = parseGsiDemGml(xml, "FG-GML-53341400-DEM5A-test.xml");
  assert.equal(parsed.tupleCount, 4);
  assert.equal(parsed.omittedPrefixCount, 1);
  assert.equal(parsed.omittedSuffixCount, 7);
  assert.deepEqual([...parsed.asset.heightsCentimeters], [
    LOCAL_DEM_NO_DATA_CENTIMETERS, 125, 250, LOCAL_DEM_NO_DATA_CENTIMETERS,
    475, LOCAL_DEM_NO_DATA_CENTIMETERS, LOCAL_DEM_NO_DATA_CENTIMETERS,
    LOCAL_DEM_NO_DATA_CENTIMETERS, LOCAL_DEM_NO_DATA_CENTIMETERS,
    LOCAL_DEM_NO_DATA_CENTIMETERS, LOCAL_DEM_NO_DATA_CENTIMETERS,
    LOCAL_DEM_NO_DATA_CENTIMETERS,
  ]);
});

test("GML parser rejects malformed tuples instead of treating them as sparse NoData", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Dataset xmlns:gml="http://www.opengis.net/gml/3.2"><DEM>
  <mesh>53341400</mesh><coverage><gml:boundedBy><gml:Envelope>
  <gml:lowerCorner>35.416666667 134.5</gml:lowerCorner>
  <gml:upperCorner>35.425 134.5125</gml:upperCorner>
  </gml:Envelope></gml:boundedBy><gml:gridDomain><gml:Grid><gml:limits><gml:GridEnvelope>
  <gml:low>0 0</gml:low><gml:high>2 2</gml:high>
  </gml:GridEnvelope></gml:limits></gml:Grid></gml:gridDomain>
  <gml:rangeSet><gml:DataBlock><gml:tupleList>
  その他,1.00
  途中で壊れた行
  その他,3.00
  </gml:tupleList></gml:DataBlock></gml:rangeSet>
  <gml:coverageFunction><gml:GridFunction><gml:sequenceRule order="+x-y">Linear</gml:sequenceRule>
  <gml:startPoint>0 0</gml:startPoint></gml:GridFunction></gml:coverageFunction>
  </coverage></DEM></Dataset>`;
  assert.throws(
    () => parseGsiDemGml(xml, "FG-GML-53341400-DEM5A-test.xml"),
    /tupleList に不正な行/
  );
});

test("server resolves an R2 GML asset before any public GSI tile request", async (t) => {
  resetLocalDemRuntimeCacheForTests();
  const asset = planeAsset();
  const query = coordinateForGrid(asset, 3.25, 3.5);
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  }));
  const encoded = gzipSync(new Uint8Array(encodeLocalDemAsset(asset)));
  const objects = new Map([
    [LOCAL_DEM_MANIFEST_KEY, localDemBytesToArrayBuffer(manifest)],
    [localDemAssetKey("DEM5A", "53341400"), localDemBytesToArrayBuffer(encoded)],
  ]);
  const reads = [];
  const persistentCache = {
    async get(key) {
      reads.push(key);
      return objects.get(key) ?? null;
    },
    async getWithStatus(key) {
      reads.push(key);
      const value = objects.get(key) ?? null;
      return { status: value ? "hit" : "miss", value };
    },
    async put() {},
  };
  configureServerRuntime({ persistentCache });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("public GSI tile fetch must not run for a covered local point");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    configureServerRuntime({});
    resetLocalDemRuntimeCacheForTests();
  });

  const [sample] = await lookupGsiElevations([{
    ...query,
    maximumDetail: "5m",
    interpolationMode: "neutral",
  }]);
  assert.equal(sample.source, "DEM5A");
  assert.ok(Math.abs(sample.heightMeters - 38.25) < 1e-9);
  assert.ok(reads.includes(LOCAL_DEM_MANIFEST_KEY));
  assert.ok(reads.includes(localDemAssetKey("DEM5A", "53341400")));
});

test("server stays local when bilinear neighbours cross a GML mesh boundary", async (t) => {
  resetLocalDemRuntimeCacheForTests();
  const westMesh = "53341400";
  const eastMesh = "53341401";
  const westAsset = constantMeshAsset(westMesh, 1_000);
  const eastAsset = constantMeshAsset(eastMesh, 2_000);
  const latitude = (westAsset.south + westAsset.north) / 2;
  const longitude = westAsset.east;
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  }));
  const objects = new Map([
    [LOCAL_DEM_MANIFEST_KEY, localDemBytesToArrayBuffer(manifest)],
    [localDemAssetKey("DEM5A", westMesh), localDemBytesToArrayBuffer(
      gzipSync(new Uint8Array(encodeLocalDemAsset(westAsset)))
    )],
    [localDemAssetKey("DEM5A", eastMesh), localDemBytesToArrayBuffer(
      gzipSync(new Uint8Array(encodeLocalDemAsset(eastAsset)))
    )],
  ]);
  configureServerRuntime({
    persistentCache: {
      async get(key) { return objects.get(key) ?? null; },
      async getWithStatus(key) {
        const value = objects.get(key) ?? null;
        return { status: value ? "hit" : "miss", value };
      },
      async put() {},
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("public GSI tile fetch must not run at a covered local mesh boundary");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    configureServerRuntime({});
    resetLocalDemRuntimeCacheForTests();
  });

  const [sample] = await lookupGsiElevations([{
    latitude,
    longitude,
    maximumDetail: "5m",
    interpolationMode: "neutral",
  }]);
  assert.equal(sample.source, "DEM5A");
  assert.ok(Math.abs(sample.heightMeters - 15) < 1e-9);
});

test("runtime rejects an R2 object whose bbox belongs to a different mesh", async (t) => {
  resetLocalDemRuntimeCacheForTests();
  const requestedMesh = "53341400";
  const wrongAsset = constantMeshAsset("53341401", 2_000);
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  }));
  const objects = new Map([
    [LOCAL_DEM_MANIFEST_KEY, localDemBytesToArrayBuffer(manifest)],
    [localDemAssetKey("DEM5A", requestedMesh), localDemBytesToArrayBuffer(
      gzipSync(new Uint8Array(encodeLocalDemAsset(wrongAsset)))
    )],
  ]);
  let assetReads = 0;
  configureServerRuntime({
    persistentCache: {
      async get(key) { return objects.get(key) ?? null; },
      async getWithStatus(key) {
        if (key !== LOCAL_DEM_MANIFEST_KEY) assetReads += 1;
        const value = objects.get(key) ?? null;
        return { status: value ? "hit" : "miss", value };
      },
      async put() {},
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
    configureServerRuntime({});
    resetLocalDemRuntimeCacheForTests();
  });
  const bounds = localDemMeshBounds(requestedMesh);
  assert.ok(bounds);
  const request = [{
    index: 0,
    latitude: (bounds.south + bounds.north) / 2,
    longitude: (bounds.west + bounds.east) / 2,
    interpolation: "bilinear",
    interpolationMode: "neutral",
  }];

  assert.equal((await lookupLocalDemElevationsForSource("DEM5A", request)).size, 0);
  assert.equal((await lookupLocalDemElevationsForSource("DEM5A", request)).size, 0);
  assert.equal(assetReads, 1, "a known-invalid R2 object should be suppressed briefly");
});

// 2026-09-30: 取得先の優先順位 R2 → Eドライブ → 国土地理院。R2にGML由来グリッドが
// あれば、Eドライブ（一括・DEM種別ごとの両方）にも公開GSIにも問い合わせない。
test("R2 GML is used before the E-drive origin", async (t) => {
  resetLocalDemRuntimeCacheForTests();
  const asset = planeAsset();
  const query = coordinateForGrid(asset, 3.25, 3.5);
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  }));
  const encoded = gzipSync(new Uint8Array(encodeLocalDemAsset(asset)));
  const objects = new Map([
    [LOCAL_DEM_MANIFEST_KEY, localDemBytesToArrayBuffer(manifest)],
    [localDemAssetKey("DEM5A", "53341400"), localDemBytesToArrayBuffer(encoded)],
  ]);
  const persistentCache = {
    async get(key) { return objects.get(key) ?? null; },
    async getWithStatus(key) {
      const value = objects.get(key) ?? null;
      return { status: value ? "hit" : "miss", value };
    },
    async put() {},
  };
  configureServerRuntime({
    persistentCache,
    localDemGateway: {
      endpoint: "https://dem-origin.example.test/v1/elevation/batch",
      originToken: "origin-token-for-tests-00000000000000000000",
      accessClientId: "client-id-for-tests.access",
      accessClientSecret: "client-secret-for-tests-000000000000000000000000",
    },
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("neither the E-drive origin nor public GSI may run for an R2-covered point");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    configureServerRuntime({});
    resetLocalDemRuntimeCacheForTests();
  });
  const [sample] = await lookupGsiElevations([{
    ...query,
    maximumDetail: "5m",
    interpolationMode: "neutral",
  }], undefined, undefined, { useLocalGateway: true });
  assert.equal(sample.source, "DEM5A");
  assert.ok(Math.abs(sample.heightMeters - 38.25) < 1e-9);
  assert.deepEqual(calls, []);
});
