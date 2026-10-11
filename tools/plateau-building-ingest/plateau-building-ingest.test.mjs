// PLATEAU建物取り込みの道具: 実物の建物ファイル2つ（札幌市・横須賀市の公開データ）と手作りのZIP、
// 模擬のファイル置き場で、最初から最後まで動かして確認する。
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBuildingExtractor } from "./cityGmlBuildings.mjs";
import { isBuildingGml, meshCodeFromEntry, runIngest, selectIngestTargets } from "./plateau-building-ingest.mjs";
import { crc32 } from "./remoteZip.mjs";
import { verifyPlateauBuildings } from "./verify-plateau-buildings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => zlib.gunzipSync(await readFile(path.join(here, "fixtures", `${name}.gz`)));

/** ZIPを作る。files: [名前, 中身, { method, corruptCrc, zip64 }]。 */
function makeZip(files, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body, options = {}] of files) {
    const method = options.method ?? 8;
    const data = method === 0 ? body : zlib.deflateRawSync(body);
    const crc = options.corruptCrc ? 12345 : crc32(body);
    const nameBytes = Buffer.from(name, "utf8");
    const localExtra = Buffer.alloc(options.localExtra ?? 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, nameBytes, localExtra, data);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(body.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, nameBytes, extra);
    offset += 30 + nameBytes.length + localExtra.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    tail.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, eocd]);
}

function startServer(archives) {
  const state = { requests: [], failOnce: new Set(), bytes: 0 };
  const server = http.createServer((request, response) => {
    const body = archives[request.url];
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? "");
    if (!body || !range) { response.writeHead(body ? 200 : 404).end(body ? "x" : ""); return; }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), body.length - 1);
    state.requests.push({ url: request.url, start, end });
    if (state.failOnce.has(`${request.url}:${start}`)) {
      state.failOnce.delete(`${request.url}:${start}`);
      response.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
      response.write(body.subarray(start, start + Math.floor((end - start) / 2)));
      setTimeout(() => response.destroy(), 20);
      return;
    }
    state.bytes += end - start + 1;
    response.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
    response.end(body.subarray(start, end + 1));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

async function readStored(directory, relative) {
  const text = zlib.gunzipSync(await readFile(path.join(directory, relative))).toString("utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

function extract(xml, chunkSize = 37) {
  const buildings = [];
  const extractor = createBuildingExtractor((building) => buildings.push(building));
  const bytes = Buffer.from(xml, "utf8");
  for (let index = 0; index < bytes.length; index += chunkSize) extractor.write(bytes.subarray(index, index + chunkSize));
  return { buildings, stats: extractor.end() };
}

const NS = 'xmlns:c="http://www.opengis.net/citygml/2.0" xmlns:b="http://www.opengis.net/citygml/building/2.0" xmlns:g="http://www.opengis.net/gml" xmlns:u="https://www.geospatial.jp/iur/uro/3.1" xmlns:xlink="http://www.w3.org/1999/xlink"';
const square = (z, size = 0.0001) => `35 139 ${z} 35 ${139 + size} ${z} ${35 + size} ${139 + size} ${z} ${35 + size} 139 ${z} 35 139 ${z}`;
const wall = "35 139 10 35 139.0001 10 35 139.0001 30 35 139 30 35 139 10";
const polygon = (list, inner = "") => `<g:Polygon><g:exterior><g:LinearRing><g:posList>${list}</g:posList></g:LinearRing></g:exterior>${inner}</g:Polygon>`;

test("selects targets and recognises building files", () => {
  assert.equal(isBuildingGml("13101_x/udx/bldg/53394611_bldg_6697_op.gml"), true);
  assert.equal(isBuildingGml("13101_x/udx/bldg/53394611_bldg_6697_appearance/a.jpg"), false);
  assert.equal(isBuildingGml("13101_x/udx/tran/53394611_tran_6697_op.gml"), false);
  assert.equal(meshCodeFromEntry("a/udx/bldg/53394611_bldg_6697_op.gml"), "53394611");
  const ok = (dataset, cityCode, year, files = 1) => ({ dataset, cityCode, year, status: "ok", url: dataset, title: dataset, categories: { "bldg-gml": { files, compressedBytes: 10 } } });
  const wards = Array.from({ length: 23 }, (_, index) => ok(`plateau-131${String(index + 1).padStart(2, "0")}-x-2025`, `131${String(index + 1).padStart(2, "0")}`, 2025));
  const base = [ok("plateau-tokyo23ku-2022", null, 2022), ok("plateau-uc23-11", null, null), ok("plateau-uc23-04", null, null, 0), { dataset: "z", status: "error" }];
  const all = selectIngestTargets([...wards, ...base]).map((target) => target.dataset);
  assert.equal(all.includes("plateau-tokyo23ku-2022"), false);
  assert.equal(all.includes("plateau-uc23-11"), true);
  assert.equal(all.includes("plateau-uc23-04"), false);
  // 区ごとの版が1つでも欠けていれば、一括版は残す。
  assert.equal(selectIngestTargets([...wards.slice(1), ...base]).some((target) => target.dataset === "plateau-tokyo23ku-2022"), true);
  assert.equal(selectIngestTargets([...wards, ...base]).find((target) => target.dataset === "plateau-uc23-11").special, true);
});

test("real file (Sapporo, LOD1 only): every building keeps its exact top face and height range", async () => {
  const source = await fixture("64413325_bldg_6697_op.gml");
  const { buildings, stats } = extract(source.toString("utf8"), 4099);
  assert.equal(stats.buildings, 25);
  assert.equal(stats.written, 25);
  assert.equal(stats.maxLod[1], 25);
  assert.equal(stats.badCoordinatePolygons, 0);
  assert.equal(stats.incomplete, false);
  assert.deepEqual(stats.srsNames, ["http://www.opengis.net/def/crs/EPSG/0/6697"]);
  const first = buildings[0];
  assert.equal(first.id, "bldg_e3cf1894-2973-4742-b301-3896f04afd99");
  assert.equal(first.mh, 2.9);
  assert.equal(first.ht, "2");
  assert.deepEqual(first.l[1].z, [100.378, 103.378]);
  assert.equal(first.l0.k, "re");
  for (const building of buildings) {
    assert.equal(building.l[1].t.length, 1, building.id);
    const top = building.l[1].t[0][0];
    for (let index = 2; index < top.length; index += 3) assert.equal(top[index], building.l[1].z[1]);
    // 元の文字列にある数値が、そのまま（丸めずに）残っている。
    assert.ok(source.includes(String(top[0])) && source.includes(String(top[1])));
  }
});

test("real file (Yokosuka, LOD2 with roofs and building parts): roof faces come from RoofSurface only", async () => {
  const source = (await fixture("52397519_bldg_6697_op.gml")).toString("utf8");
  const { buildings, stats } = extract(source, 65536);
  assert.equal(stats.buildings, 13);
  assert.equal(stats.maxLod[1], 11);
  assert.equal(stats.maxLod[2], 2);
  const roofPolygons = [...source.matchAll(/<bldg:RoofSurface[\s\S]*?<\/bldg:RoofSurface>/gu)].reduce((total, match) => total + (match[0].match(/<gml:Polygon/gu) ?? []).length, 0);
  const lod2 = buildings.filter((building) => building.l[2]);
  assert.equal(roofPolygons, 335);
  assert.equal(lod2.reduce((total, building) => total + building.l[2].t.length, 0), roofPolygons);
  const parts = buildings.find((building) => building.pmh);
  assert.deepEqual(parts.pmh, [11.3, 9.7]);
  assert.equal(parts.mh, undefined);
  for (const building of lod2) {
    // 屋根の最高点は、その建物の最高点を超えず、LOD1の箱とも矛盾しない範囲にある。
    let highest = -Infinity;
    for (const face of building.l[2].t) for (let index = 2; index < face[0].length; index += 3) highest = Math.max(highest, face[0][index]);
    assert.ok(highest <= building.l[2].z[1] + 1e-9);
    assert.ok(Math.abs(highest - building.l[2].z[1]) < 0.01, `${building.id} ${highest} ${building.l[2].z[1]}`);
  }
});

test("chunk boundaries never change the result", async () => {
  const source = (await fixture("52397519_bldg_6697_op.gml")).toString("utf8");
  const reference = JSON.stringify(extract(source, 1 << 20).buildings);
  for (const size of [1, 7, 1000, 4096, 50_001]) {
    if (size === 1 && source.length > 200_000) {
      assert.equal(JSON.stringify(extract(source.slice(0, 120_000) , 1).buildings), JSON.stringify(extract(source.slice(0, 120_000), 1 << 20).buildings));
    } else assert.equal(JSON.stringify(extract(source, size).buildings), reference, `chunk ${size}`);
  }
});

test("hand-written cases: other prefixes, pos lists, holes, installations, interiors, bad data", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><c:CityModel ${NS}>
  <g:boundedBy><g:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6697" srsDimension="3"><g:lowerCorner>35 139 0</g:lowerCorner><g:upperCorner>36 140 9</g:upperCorner></g:Envelope></g:boundedBy>
  <!-- a > comment --><c:cityObjectMember><b:Building g:id="A&amp;1">
    <b:measuredHeight uom="m">20.0</b:measuredHeight><u:lod1HeightType codeSpace="x>y">3</u:lod1HeightType>
    <b:lod1Solid><g:Solid><g:exterior><g:CompositeSurface>
      <g:surfaceMember>${polygon(square(10))}</g:surfaceMember>
      <g:surfaceMember>${polygon(square(30), `<g:interior><g:LinearRing><g:pos>35.00002 139.00002 30</g:pos><g:pos>35.00002 139.00004 30</g:pos><g:pos>35.00004 139.00004 30</g:pos><g:pos>35.00002 139.00002 30</g:pos></g:LinearRing></g:interior>`)}</g:surfaceMember>
      <g:surfaceMember>${polygon(wall)}</g:surfaceMember>
    </g:CompositeSurface></g:exterior></g:Solid></b:lod1Solid>
    <b:lod2Solid><g:Solid><g:exterior><g:CompositeSurface><g:surfaceMember xlink:href="#r1"/></g:CompositeSurface></g:exterior></g:Solid></b:lod2Solid>
    <b:boundedBy><b:RoofSurface><b:lod2MultiSurface><g:MultiSurface><g:surfaceMember>${polygon("35 139 31 35 139.0001 31 35.0001 139.0001 33.5 35.0001 139 33.5 35 139 31")}</g:surfaceMember></g:MultiSurface></b:lod2MultiSurface></b:RoofSurface></b:boundedBy>
    <b:boundedBy><b:WallSurface><b:lod2MultiSurface><g:MultiSurface><g:surfaceMember>${polygon(wall)}</g:surfaceMember></g:MultiSurface></b:lod2MultiSurface></b:WallSurface></b:boundedBy>
    <b:boundedBy><b:GroundSurface><b:lod2MultiSurface><g:MultiSurface><g:surfaceMember>${polygon(square(9.5))}</g:surfaceMember></g:MultiSurface></b:lod2MultiSurface></b:GroundSurface></b:boundedBy>
    <b:outerBuildingInstallation><b:BuildingInstallation><b:lod2Geometry><g:MultiSurface>
      <g:surfaceMember>${polygon(square(45, 0.00001))}</g:surfaceMember><g:surfaceMember>${polygon(wall)}</g:surfaceMember>
    </g:MultiSurface></b:lod2Geometry></b:BuildingInstallation></b:outerBuildingInstallation>
    <b:interiorRoom><b:Room><b:lod4Solid>${polygon(square(99))}</b:lod4Solid></b:Room></b:interiorRoom>
  </b:Building></c:cityObjectMember>
  <c:cityObjectMember><b:Building g:id="B"><b:lod1Solid>${polygon("139 35 10 139.0001 35 10 139.0001 35.0001 10 139 35 10")}</b:lod1Solid></b:Building></c:cityObjectMember>
  <c:cityObjectMember><b:Building g:id="C"><b:measuredHeight>5</b:measuredHeight></b:Building></c:cityObjectMember>
  </c:CityModel>`;
  for (const size of [1, 13, 100_000]) {
    const { buildings, stats } = extract(xml, size);
    assert.equal(stats.buildings, 3);
    assert.equal(stats.written, 1);
    assert.equal(stats.withoutGeometry, 2);
    assert.equal(stats.badCoordinatePolygons, 1);
    assert.equal(stats.hrefOnlyLods, 1);
    const [a] = buildings;
    assert.equal(a.id, "A&1");
    assert.equal(a.mh, 20);
    assert.equal(a.ht, "3");
    assert.deepEqual(a.l[1].z, [10, 30]);
    assert.equal(a.l[1].t.length, 1, "bottom face and wall are not kept");
    assert.equal(a.l[1].t[0].length, 2, "the hole is kept with its face");
    assert.equal(a.l[1].t[0][1].length, 12);
    assert.deepEqual(a.l[2].z, [9.5, 33.5]);
    assert.equal(a.l[2].t.length, 1);
    assert.deepEqual(a.l[2].zi, [10, 45]);
    assert.equal(a.l[2].ti.length, 1);
    assert.equal(a.l[4], undefined, "interior rooms are ignored");
    assert.equal(stats.maxLod[2], 1);
  }
  assert.equal(extract("<c:CityModel " + NS + "><c:cityObjectMember><b:Building g:id='x'>", 5).stats.incomplete, true);
});

test("end to end: only building files are fetched, results are verified, failures are retried on the next run", async () => {
  const sapporo = await fixture("64413325_bldg_6697_op.gml");
  const yokosuka = await fixture("52397519_bldg_6697_op.gml");
  const wrongSrs = Buffer.from(sapporo.toString("utf8").replace("EPSG/0/6697", "EPSG/0/6668"), "utf8");
  const filler = Buffer.alloc(300_000, 7);
  const cityA = makeZip([
    ["a/udx/dem/5339_dem.gml", filler, { method: 0 }],
    ["a/udx/bldg/64413325_bldg_6697_op.gml", sapporo, { localExtra: 20 }],
    ["a/udx/bldg/64413325_bldg_6697_appearance/t.jpg", filler, { method: 0 }],
    ["a/udx/bldg/52397519_bldg_6697_op.gml", yokosuka],
  ]);
  const cityB = makeZip([
    ["b/udx/bldg/11111111_bldg_6697_op.gml", sapporo, { method: 0 }],
    ["b/udx/bldg/22222222_bldg_6697_op.gml", sapporo, { corruptCrc: true }],
    ["b/udx/bldg/33333333_bldg_6697_op.gml", sapporo, { method: 9 }],
    ["b/udx/bldg/44444444_bldg_6697_op.gml", wrongSrs],
    ["b/udx/dem/x.gml", filler, { method: 0 }],
  ], { zip64: true });
  const { server, state, base } = await startServer({ "/a.zip": cityA, "/b.zip": cityB });
  const directory = await mkdtemp(path.join(os.tmpdir(), "plateau-ingest-"));
  const targets = [
    { dataset: "plateau-01100-sapporo-shi-2020", title: "札幌市", cityCode: "01100", year: 2020, url: `${base}/a.zip`, special: false, expectedFiles: 2 },
    { dataset: "plateau-99999-b-2024", title: "B", cityCode: "99999", year: 2024, url: `${base}/b.zip`, special: false, expectedFiles: 4 },
    { dataset: "plateau-missing", title: "無い", cityCode: null, year: null, url: `${base}/none.zip`, special: true, expectedFiles: 1 },
  ];
  const quiet = () => {};
  try {
    // 途中で通信が切れても、やり直して取り込める。
    const yokosukaOffset = cityA.indexOf(Buffer.from("a/udx/bldg/52397519_bldg_6697_op.gml")) - 30;
    state.failOnce.add(`/a.zip:${yokosukaOffset}`);
    const first = await runIngest({ targets, outputDirectory: directory, log: quiet, freeBytes: async () => Infinity, retryDelayMs: 5 });
    assert.equal(first.summary.files, 3);
    assert.equal(first.summary.written, 25 + 13 + 25);
    assert.equal(first.summary.buildingsByHighestLod[2], 2);
    assert.equal(first.summary.complete, false);
    assert.deepEqual(first.failures.map((failure) => failure.entry).sort(), [
      "b/udx/bldg/22222222_bldg_6697_op.gml", "b/udx/bldg/33333333_bldg_6697_op.gml", "b/udx/bldg/44444444_bldg_6697_op.gml", null,
    ].sort());
    assert.match(first.failures.find((failure) => failure.entry?.includes("2222")).message, /CRC/u);
    assert.match(first.failures.find((failure) => failure.entry?.includes("3333")).message, /圧縮方式/u);
    assert.match(first.failures.find((failure) => failure.entry?.includes("4444")).message, /座標系/u);
    // 地形や写真の本体は取りに行っていない（取った量は、建物ファイル＋目次＋やり直し分に収まる）。
    for (const [url, zip, name] of [["/a.zip", cityA, "a/udx/dem/5339_dem.gml"], ["/a.zip", cityA, "a/udx/bldg/64413325_bldg_6697_appearance/t.jpg"], ["/b.zip", cityB, "b/udx/dem/x.gml"]]) {
      const inside = zip.indexOf(Buffer.from(name)) + name.length + 10_000;
      assert.equal(state.requests.some((request) => request.url === url && request.start <= inside && request.end >= inside), false, name);
    }

    const stored = await readStored(directory, "buildings/plateau-01100-sapporo-shi-2020/52397519_bldg_6697_op.gml.ndjson.gz");
    assert.equal(stored[0].type, "header");
    assert.equal(stored[0].heightDatum, "source-orthometric");
    assert.equal(stored.length, 14);
    assert.deepEqual(stored.slice(1), extract(yokosuka.toString("utf8"), 1 << 20).buildings);
    const manifest = (await readFile(path.join(directory, "manifest.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const row = manifest.find((item) => item.entry.includes("52397519"));
    assert.equal(row.mesh, "52397519");
    assert.ok(row.bbox[0] > 35.2 && row.bbox[2] < 35.3 && row.bbox[1] > 139.7 && row.bbox[3] < 139.8);
    // 失敗したファイルの書きかけは残らない。
    const leftovers = (await readdir(path.join(directory, "buildings"), { recursive: true })).filter((name) => String(name).endsWith(".partial"));
    assert.deepEqual(leftovers, []);

    // 2回目: 済んだ分は取り直さず、消えたファイルと失敗分だけやり直す。
    await rm(path.join(directory, "buildings/plateau-01100-sapporo-shi-2020/64413325_bldg_6697_op.gml.ndjson.gz"));
    const before = state.requests.length;
    const second = await runIngest({ targets, outputDirectory: directory, log: quiet, freeBytes: async () => Infinity, retryDelayMs: 5 });
    assert.equal(second.summary.newFilesThisRun, 1);
    assert.equal(second.summary.files, 3);
    const sapporoOffset = cityA.indexOf(Buffer.from("a/udx/bldg/64413325_bldg_6697_op.gml")) - 30;
    const again = state.requests.slice(before).filter((request) => request.url === "/a.zip");
    assert.equal(again.filter((request) => request.start === sapporoOffset).length, 1);
    assert.equal(again.filter((request) => request.start === yokosukaOffset).length, 0);

    // 空き容量が足りなければ、書き込む前に止める。
    const third = await runIngest({ targets: [targets[1]], outputDirectory: await mkdtemp(path.join(os.tmpdir(), "plateau-ingest-")), log: quiet, freeBytes: async () => 1000, retryDelayMs: 5 });
    assert.equal(third.summary.stoppedForDisk, true);
    assert.equal(third.summary.files, 0);
  } finally {
    server.close();
  }
});

test("a moved root manifest is rebuilt from stored files without downloading source bodies", async () => {
  const sapporo = await fixture("64413325_bldg_6697_op.gml");
  const empty = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><c:CityModel ${NS}><g:boundedBy><g:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6697" srsDimension="3"><g:lowerCorner>35 139 0</g:lowerCorner><g:upperCorner>36 140 9</g:upperCorner></g:Envelope></g:boundedBy></c:CityModel>`, "utf8");
  const zip = makeZip([
    ["a/udx/bldg/11111111_bldg_6697_op.gml", sapporo],
    ["a/udx/bldg/22222222_bldg_6697_op.gml", sapporo],
    ["a/udx/bldg/33333333_bldg_6697_op.gml", empty],
  ]);
  const { server, state, base } = await startServer({ "/complete.zip": zip });
  const directory = await mkdtemp(path.join(os.tmpdir(), "plateau-recovery-"));
  const importDirectory = await mkdtemp(path.join(os.tmpdir(), "plateau-recovery-import-"));
  const imported = path.join(importDirectory, "manifest.ndjson");
  const targets = [{
    dataset: "plateau-12345-recovery-2026", title: "復旧", cityCode: "12345", year: 2026,
    url: `${base}/complete.zip`, special: false, expectedFiles: 3,
  }];
  try {
    const first = await runIngest({ targets, outputDirectory: directory, log: () => {}, freeBytes: async () => Infinity, retryDelayMs: 5 });
    assert.equal(first.summary.complete, true);
    assert.equal(first.summary.files, 3);
    const original = (await readFile(path.join(directory, "manifest.ndjson"), "utf8")).trim().split("\n");
    assert.equal(original.length, 3);
    await writeFile(imported, `${original[0]}\n`, "utf8");
    await rm(path.join(directory, "manifest.ndjson"));
    await rm(path.join(directory, "manifest-fragments-v1"), { recursive: true, force: true });

    const before = state.requests.length;
    const second = await runIngest({
      targets,
      outputDirectory: directory,
      additionalManifestPaths: [imported],
      log: () => {},
      freeBytes: async () => Infinity,
      retryDelayMs: 5,
    });
    assert.equal(second.summary.complete, true);
    assert.equal(second.summary.files, 3);
    assert.equal(second.summary.newFilesThisRun, 0);
    const repaired = (await readFile(path.join(directory, "manifest.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(repaired.length, 3);
    assert.equal(repaired.filter((record) => record.file === null).length, 1);
    assert.equal(repaired.reduce((count, record) => count + record.written, 0), 50);
    // Only the ZIP directory probe is made. None of the three entries is fetched again.
    assert.ok(state.requests.length - before <= 2);
    const report = JSON.parse(await readFile(path.join(directory, "manifest-recovery.json"), "utf8"));
    assert.equal(report.complete, true);
    assert.equal(report.repairedRecords, 2);
    assert.equal((await readdir(path.join(directory, "manifest-fragments-v1"))).length, 1);
    const standardVerification = await verifyPlateauBuildings({ outputDirectory: directory, targets, log: () => {} });
    assert.equal(standardVerification.status, "complete");
    assert.equal(standardVerification.physicalFiles, 2);
    const deepVerification = await verifyPlateauBuildings({ outputDirectory: directory, targets, deep: true, log: () => {} });
    assert.equal(deepVerification.status, "complete");
    assert.equal(deepVerification.errorCount, 0);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
    await rm(importDirectory, { recursive: true, force: true });
  }
});

test("different source paths with the same basename are stored and verified independently", async () => {
  const sapporo = await fixture("64413325_bldg_6697_op.gml");
  const zip = makeZip([
    ["first/udx/bldg/64413325_bldg_6697_op.gml", sapporo],
    ["second/udx/bldg/64413325_bldg_6697_op.gml", sapporo],
  ]);
  const { server, base } = await startServer({ "/duplicate.zip": zip });
  const directory = await mkdtemp(path.join(os.tmpdir(), "plateau-duplicate-name-"));
  const targets = [{
    dataset: "plateau-duplicate-2026", title: "重複名", cityCode: null, year: 2026,
    url: `${base}/duplicate.zip`, special: true, expectedFiles: 2,
  }];
  try {
    const result = await runIngest({
      targets, outputDirectory: directory, log: () => {}, freeBytes: async () => Infinity, retryDelayMs: 5,
    });
    assert.equal(result.summary.complete, true);
    const rows = (await readFile(path.join(directory, "manifest.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(new Set(rows.map((row) => row.file)).size, 2);
    assert.ok(rows.every((row) => /-[a-f0-9]{12}\.gml\.ndjson\.gz$/u.test(row.file)));
    for (const row of rows) {
      const [header] = await readStored(directory, row.file);
      assert.equal(header.entry, row.entry);
    }
    const verified = await verifyPlateauBuildings({ outputDirectory: directory, targets, deep: true, log: () => {} });
    assert.equal(verified.status, "complete");
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
