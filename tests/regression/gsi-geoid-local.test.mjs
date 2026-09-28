import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as geoidEndpoint } from "../../functions/api/gsi-geoid.ts";
import { lookupGsiGeoidHeight } from "../../server/gsiGeoid.ts";
import {
  JPGEO2024_LOCAL_DATASET,
  clearLocalJpgeo2024TileCache,
  lookupLocalJpgeo2024Height,
} from "../../server/jpgeo2024Local.ts";

const referencePoints = [
  { name: "Tokyo", latitude: 35.681236, longitude: 139.767125, cgi: 36.7614 },
  { name: "Osaka", latitude: 34.702485, longitude: 135.495951, cgi: 37.5925 },
  { name: "Sapporo", latitude: 43.068661, longitude: 141.350755, cgi: 32.1957 },
  { name: "Fukuoka", latitude: 33.590355, longitude: 130.401716, cgi: 32.5869 },
  // The CGI separately reports Hrefconv2024=0.6840 m here. AstroSight has
  // always consumed OutputData.geoidHeight, so the matching model is
  // JPGEO2024 itself (30.8471), not the combined 31.5311 m field.
  { name: "Naha", latitude: 26.212401, longitude: 127.680932, cgi: 30.8471 },
];

function eventContext(request) {
  return {
    request,
    env: {},
    params: {},
    data: {},
    functionPath: new URL(request.url).pathname,
    waitUntil() {},
    passThroughOnException() {},
    next: async () => new Response(null, { status: 404 }),
  };
}

test("bundled JPGEO2024 bilinear interpolation matches the official CGI at five Japanese locations", () => {
  assert.equal(JPGEO2024_LOCAL_DATASET.points, 2_038_071);
  assert.equal(JPGEO2024_LOCAL_DATASET.latitudeStep, 1 / 60);
  assert.equal(JPGEO2024_LOCAL_DATASET.longitudeStep, 1.5 / 60);
  clearLocalJpgeo2024TileCache();
  for (const point of referencePoints) {
    const actual = lookupLocalJpgeo2024Height(point.latitude, point.longitude);
    assert.equal(typeof actual, "number", `${point.name} must be covered locally`);
    assert.ok(
      Math.abs(actual - point.cgi) <= 0.000_051,
      `${point.name}: local=${actual}, CGI=${point.cgi}`,
    );
  }
});

test("lossless tiles preserve official grid nodes across internal and outer tile seams", () => {
  // Values are read directly from the approved JPGEO2024.isg source. Rows and
  // columns straddle the 64x64 lossless-tile boundaries, including the smaller
  // east/south edge tiles, so decoder indexing errors cannot hide behind the
  // five city interpolation checks above.
  const gridNodes = [
    { row: 0, column: 0, expected: 4.6065 },
    { row: 0, column: 64, expected: 7.2072 },
    { row: 63, column: 63, expected: 7.6150 },
    { row: 64, column: 64, expected: 7.6754 },
    { row: 127, column: 128, expected: 13.3987 },
    { row: 128, column: 127, expected: 13.3651 },
    { row: 1_589, column: 1_279, expected: 31.2773 },
    { row: 1_590, column: 1_280, expected: 31.2076 },
  ];
  clearLocalJpgeo2024TileCache();
  for (const node of gridNodes) {
    const latitude = JPGEO2024_LOCAL_DATASET.latitudeMax -
      node.row * JPGEO2024_LOCAL_DATASET.latitudeStep;
    const longitude = JPGEO2024_LOCAL_DATASET.longitudeMin +
      node.column * JPGEO2024_LOCAL_DATASET.longitudeStep;
    const actual = lookupLocalJpgeo2024Height(latitude, longitude);
    assert.ok(
      typeof actual === "number" && Math.abs(actual - node.expected) <= 1e-10,
      `grid ${node.row},${node.column}: local=${actual}, source=${node.expected}`,
    );
  }
});

test("the complete former AstroSight Japan rectangle is local and outside cells remain eligible for fallback", () => {
  for (const [latitude, longitude] of [
    [20, 122],
    [20, 154],
    [46.5, 122],
    [46.5, 154],
  ]) {
    assert.equal(typeof lookupLocalJpgeo2024Height(latitude, longitude), "number");
  }
  assert.equal(lookupLocalJpgeo2024Height(19.9999, 139), null);
  assert.equal(lookupLocalJpgeo2024Height(35, 154.0001), null);
});

test("regional and point-specific server lookups never fetch for Japanese coordinates", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used for bundled JPGEO2024 coverage");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const point = referencePoints[0];
  const pointSpecific = await lookupGsiGeoidHeight(point.latitude, point.longitude, undefined, true);
  assert.ok(Math.abs(pointSpecific - point.cgi) <= 0.000_051);

  const regional = await lookupGsiGeoidHeight(point.latitude, point.longitude, undefined, false);
  const expectedRegional = lookupLocalJpgeo2024Height(
    Number(point.latitude.toFixed(2)),
    Number(point.longitude.toFixed(2)),
  );
  assert.equal(regional, expectedRegional);
});

test("legacy CGI fallback is retained only for valid ISG coordinates outside the bundled rectangle", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    assert.match(String(input), /geoidcalc\.pl/u);
    return Response.json({ OutputData: { geoidHeight: "12.3456" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.equal(await lookupGsiGeoidHeight(49, 159, undefined, true), 12.3456);
  assert.equal(fetchCount, 1);
  await assert.rejects(lookupGsiGeoidHeight(51, 159, undefined, true), /取得範囲外/u);
  assert.equal(fetchCount, 1);
});

test("GET and batch POST Pages Function paths bypass R2 and external fetch for local data", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used by the local Pages Function path");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const tokyo = referencePoints[0];
  const getRequest = new Request(
    `https://astrosight.example/api/gsi-geoid?latitude=${tokyo.latitude}&longitude=${tokyo.longitude}&precision=point`,
  );
  const getResponse = await geoidEndpoint(eventContext(getRequest));
  assert.equal(getResponse.status, 200);
  const getBody = await getResponse.json();
  assert.equal(getBody.cache, "local");
  assert.ok(Math.abs(getBody.geoidHeightMeters - tokyo.cgi) <= 0.000_051);

  const postRequest = new Request("https://astrosight.example/api/gsi-geoid", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      precision: "point",
      points: referencePoints.map(({ latitude, longitude }) => ({ latitude, longitude })),
    }),
  });
  const postResponse = await geoidEndpoint(eventContext(postRequest));
  assert.equal(postResponse.status, 200);
  const postBody = await postResponse.json();
  assert.equal(postBody.cache, "local");
  assert.equal(postBody.geoidHeightMeters.length, referencePoints.length);
  for (let index = 0; index < referencePoints.length; index += 1) {
    assert.ok(Math.abs(postBody.geoidHeightMeters[index] - referencePoints[index].cgi) <= 0.000_051);
  }
});
