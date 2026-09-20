import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureDirectory = new URL("../fixtures/gsi-water/", import.meta.url);
const fixtureNames = [
  "z13-7247-3255.pbf",
  "z16-57535-25914.pbf",
  "z16-57673-25877.pbf",
  "z16-58159-25892.pbf",
];
const fixtures = new Map(await Promise.all(fixtureNames.map(async (name) => [
  name.replace(/^z(\d+)-(\d+)-(\d+)\.pbf$/, "$1/$2/$3"),
  await readFile(new URL(name, fixtureDirectory)),
])));

const originalFetch = globalThis.fetch;
const {
  clearGsiWaterTileCacheForTests,
  lookupGsiWaterSurfaceContexts,
} = await import("../../server/gsiWaterSurface.ts");

function fixtureFetch() {
  return async (input, init = {}) => {
    if (init.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const url = new URL(String(input));
    const match = url.pathname.match(/\/experimental_bvmap\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    assert.ok(match, `unexpected URL: ${url}`);
    const body = fixtures.get(`${match[1]}/${match[2]}/${match[3]}`);
    return body
      ? new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        })
      : new Response(null, { status: 404 });
  };
}

test("z16 authoritative polygons distinguish river, land, lake, coast and open sea in input order", async () => {
  clearGsiWaterTileCacheForTests();
  globalThis.fetch = fixtureFetch();
  const points = [
    { latitude: 35.36612482179514, longitude: 136.81 },
    { latitude: 35.36483335131465, longitude: 136.810102994149 },
    { latitude: 35.2, longitude: 136.05 },
    { latitude: 35.296, longitude: 139.48 },
    { latitude: 34.6, longitude: 138.5 },
  ];
  const contexts = await lookupGsiWaterSurfaceContexts(points);
  assert.deepEqual(contexts, [
    { onWaterSurface: true, waterSurfaceKind: "river" },
    { onWaterSurface: false, waterSurfaceKind: "none" },
    { onWaterSurface: true, waterSurfaceKind: "sea-or-other-water" },
    { onWaterSurface: true, waterSurfaceKind: "sea-or-other-water" },
    { onWaterSurface: true, waterSurfaceKind: "sea-or-other-water" },
  ]);
});

test("water-only site context uses GSI without contacting Overpass when coverage is complete", async () => {
  clearGsiWaterTileCacheForTests();
  let nonGsiRequestCount = 0;
  const serveFixture = fixtureFetch();
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("cyberjapandata.gsi.go.jp")) {
      nonGsiRequestCount += 1;
      throw new Error("Overpass must not be contacted");
    }
    return serveFixture(input, init);
  };
  const { lookupOsmSiteContexts } = await import("../../server/osmSiteContext.ts");
  const [context] = await lookupOsmSiteContexts(
    [{ latitude: 35.36612482179514, longitude: 136.81 }],
    undefined,
    false,
    "water-only"
  );
  assert.equal(context.waterSurfaceKind, "river");
  assert.equal(context.onWaterSurface, true);
  assert.equal(nonGsiRequestCount, 0);
});

test("unknown GSI coverage returns null instead of guessing land or water", async () => {
  clearGsiWaterTileCacheForTests();
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(
    await lookupGsiWaterSurfaceContexts([{ latitude: 0, longitude: 0 }]),
    null
  );
});

test("tile requests are bounded to six concurrent fetches", async () => {
  clearGsiWaterTileCacheForTests();
  let active = 0;
  let maximumActive = 0;
  globalThis.fetch = async (_input, init = {}) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 12);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      return new Response(null, { status: 404 });
    } finally {
      active -= 1;
    }
  };
  const points = Array.from({ length: 18 }, (_, index) => ({
    latitude: 20,
    longitude: 120 + index * 0.02,
  }));
  assert.equal(await lookupGsiWaterSurfaceContexts(points), null);
  assert.ok(maximumActive > 1);
  assert.ok(maximumActive <= 6, `maximum concurrent fetches: ${maximumActive}`);
});

test("caller abort is propagated while a tile request is running", async () => {
  clearGsiWaterTileCacheForTests();
  globalThis.fetch = async (_input, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  const controller = new AbortController();
  const pending = lookupGsiWaterSurfaceContexts(
    [{ latitude: 35, longitude: 136 }],
    controller.signal
  );
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test.after(() => {
  clearGsiWaterTileCacheForTests();
  globalThis.fetch = originalFetch;
});
