// 2026-09-30: 端末完結の地形経路（国土地理院への直接取得＋端末デコード＋端末補間
// ＋端末内JPGEO2024）が、サーバー経路と「完全に同じ値」を返すこと、およびサーバー
// 障害時に候補計算が止まらないことを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.window ??= { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};

import { encodeGsiPng, hash, syntheticGsiTileResponse, syntheticTile } from "./helpers/gsiSyntheticTiles.mjs";

let gsiTileRequests = 0;
let pagesElevationRequests = 0;
let pagesDemTileRequests = 0;
let pagesMode = "fail";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const tile = syntheticGsiTileResponse(url);
  if (tile) {
    gsiTileRequests += 1;
    return tile;
  }
  if (url.includes("/api/gsi-elevation")) {
    pagesElevationRequests += 1;
    if (pagesMode === "ok") {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        samples: body.points.map(() => ({ heightMeters: 12.34, source: "DEM10B" })),
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (pagesMode === "html") {
      return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    }
    throw new TypeError("Failed to fetch");
  }
  if (url.includes("/api/gsi-dem-tile")) {
    pagesDemTileRequests += 1;
    if (pagesMode !== "ok") throw new TypeError("Failed to fetch");
    // 実サーバー（functions/api/gsi-dem-tile.ts）と同じ形式: little-endian int32 + 寸法ヘッダー。
    const params = new URL(url, "http://localhost").searchParams;
    const source = { DEM1A: ["dem1a_png", 17], DEM5A: ["dem5a_png", 15], DEM5B: ["dem5b_png", 15],
      DEM5C: ["dem5c_png", 15], DEM10B: ["dem_png", 14] }[params.get("source")];
    const png = syntheticTile(source[0], source[1], Number(params.get("x")), Number(params.get("y")));
    if (!png) return new Response(null, { status: 404 });
    const { decodeGsiDemPngSync: decode } = await import("../../server/gsiDemPng.ts");
    const tile = decode(png, inflateSync);
    const body = new ArrayBuffer(tile.heightsCentimeters.length * 4);
    const view = new DataView(body);
    tile.heightsCentimeters.forEach((value, index) => view.setInt32(index * 4, value, true));
    return new Response(body, { headers: {
      "x-astrosight-dem-width": String(tile.width), "x-astrosight-dem-height": String(tile.height),
    } });
  }
  if (url.includes("/api/gsi-geoid")) throw new TypeError("Failed to fetch");
  return realFetch(input, init);
};

const { decodeGsiDemPngSync, decodeGsiDemPngAsync } = await import("../../server/gsiDemPng.ts");
const server = await import("../../server/gsiElevation.ts");
const { runWithServerRuntime } = await import("../../server/cloudflareRuntime.ts");
const { lookupGsiGeoidHeight } = await import("../../server/gsiGeoid.ts");
const deviceTiles = await import("../../src/cesium/gsiDemTileCache.ts");
const client = await import("../../src/cesium/gsiElevationClient.ts");

const inflateAsync = async (compressed) => new Uint8Array(
  await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()
);

test("server (node:zlib) and device (DecompressionStream) decoders are bit-identical", async () => {
  for (let seed = 0; seed < 10; seed += 1) {
    const centimeters = new Int32Array(256 * 256);
    for (let index = 0; index < centimeters.length; index += 1) {
      const h = hash(index, seed);
      centimeters[index] = h % 23 === 0 ? -2_147_483_648 : (h % 800_000) - 200_000;
    }
    const png = encodeGsiPng(centimeters, seed % 2 === 0, seed);
    const serverTile = decodeGsiDemPngSync(png, inflateSync);
    const deviceTile = await decodeGsiDemPngAsync(png, inflateAsync);
    assert.deepEqual(serverTile.heightsCentimeters, centimeters);
    assert.deepEqual(deviceTile.heightsCentimeters, centimeters);
  }
});

test("device-direct heights equal server lookupGsiElevations exactly (all details, both modes)", async () => {
  const points = [];
  for (let index = 0; index < 180; index += 1) {
    const h = hash(index, 42);
    points.push({
      latitude: 35.60 + (h % 10_000) / 50_000,
      longitude: 139.70 + (hash(index, 43) % 10_000) / 40_000,
      maximumDetail: ["1m", "5m", "10m", undefined][index % 4],
      interpolationMode: index % 3 === 0 ? "neutral" : "los-safe",
    });
  }
  // タイル境界（4x4近傍が隣接タイルへまたがる）を必ず含める。
  points.push({ latitude: 35.6812, longitude: 139.7671, maximumDetail: "1m", interpolationMode: "neutral" });
  const expected = await runWithServerRuntime({}, () =>
    server.lookupGsiElevations(points, undefined, undefined, { useLocalGateway: false })
  );
  const actual = await deviceTiles.resolveGsiSamplesWithDirectTiles(points);
  assert.equal(actual.length, expected.length);
  let resolvedWithData = 0;
  actual.forEach((sample, index) => {
    assert.notEqual(sample, null, `point ${index} must resolve on device`);
    assert.equal(sample.source, expected[index].source, `source mismatch at ${index}`);
    assert.equal(sample.heightMeters, expected[index].heightMeters, `height mismatch at ${index}`);
    if (sample.heightMeters !== null) resolvedWithData += 1;
  });
  assert.ok(resolvedWithData > 150);
  const sources = new Set(actual.map((sample) => sample.source));
  assert.ok(sources.has("DEM1A") && sources.has("DEM5A") && sources.has("DEM10B"));
});

test("device-local JPGEO2024 matches the server geoid for regional and point modes", async () => {
  const jpgeo = await import("../../server/jpgeo2024Local.ts");
  for (const [latitude, longitude] of [[35.71417409, 139.83304891], [34.6937, 135.5023], [43.0621, 141.3544], [26.2124, 127.6809]]) {
    const regional = await lookupGsiGeoidHeight(latitude, longitude, undefined, false);
    assert.equal(jpgeo.lookupLocalJpgeo2024Height(Number(latitude.toFixed(2)), Number(longitude.toFixed(2))), regional);
    const point = await lookupGsiGeoidHeight(latitude, longitude, undefined, true);
    assert.equal(jpgeo.lookupLocalJpgeo2024Height(latitude, longitude), point);
  }
});

test("a cancelled request's hung tile fetch cannot block a later request (Workers request scope)", async () => {
  server.resetGsiElevationMemoryCacheForTests();
  const point = [{ latitude: 36.4, longitude: 138.4, maximumDetail: "10m" }];
  const previousFetch = globalThis.fetch;
  let hang = true;
  globalThis.fetch = async (input, init) => {
    if (hang && String(input).includes("cyberjapandata")) return new Promise(() => {});
    return previousFetch(input, init);
  };
  try {
    const requestA = new AbortController();
    const first = runWithServerRuntime({}, () =>
      server.lookupGsiElevations(point, requestA.signal, undefined, { useLocalGateway: false })
    ).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    requestA.abort();
    assert.equal((await first).name, "AbortError");
    hang = false;
    const second = await Promise.race([
      runWithServerRuntime({}, () =>
        server.lookupGsiElevations(point, undefined, undefined, { useLocalGateway: false })
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error("request B waited on request A")), 3_000)),
    ]);
    assert.equal(second[0].source, "DEM10B");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a Pages outage fails fast without recursive splitting and opens the breaker", async () => {
  pagesMode = "html";
  pagesElevationRequests = 0;
  const points = Array.from({ length: 352 }, (_, index) => ({
    latitude: 35.7 + index * 1e-4, longitude: 139.8, maximumDetail: "10m", interpolationMode: "neutral",
  }));
  const startedAt = Date.now();
  const result = await client.fetchGsiElevationSamples(points, undefined, fetch, "interactive");
  assert.equal(result.failedPointCount, 352);
  assert.equal(pagesElevationRequests, 1, "an outage must not be split into hundreds of retries");
  assert.ok(Date.now() - startedAt < 2_000);
  const again = await client.fetchGsiElevationSamples(points, undefined, fetch, "interactive");
  assert.equal(again.failedPointCount, 352);
  assert.equal(pagesElevationRequests, 1, "breaker must skip the server while it is known to be down");
  assert.ok(client.isGsiElevationServerBreakerOpen());
});

test("no response from Pages (client timeout) is not split into hundreds of retries", async () => {
  client.__resetGsiElevationServerBreakerForTesting();
  let calls = 0;
  const timeoutFetcher = async () => {
    calls += 1;
    const error = new Error("国土地理院標高APIがタイムアウトしました");
    error.name = "TimeoutError";
    throw error;
  };
  const points = Array.from({ length: 352 }, (_, index) => ({
    latitude: 35.7 + index * 1e-4, longitude: 139.8, maximumDetail: "10m", interpolationMode: "neutral",
  }));
  const result = await client.fetchGsiElevationSamples(points, undefined, timeoutFetcher, "interactive");
  assert.equal(result.failedPointCount, 352);
  assert.equal(calls, 1, "the production hang produced 12 s x recursive splits; now one attempt");
  client.__resetGsiElevationServerBreakerForTesting();
});

test("source order: a healthy server (R2 -> E-drive -> GSI) is used before device-direct GSI", async () => {
  const { Cartographic } = await import("cesium");
  const terrain = await import("../../src/cesium/worldTerrain.ts");
  client.__resetGsiElevationServerBreakerForTesting();
  pagesMode = "ok";
  pagesElevationRequests = 0;
  const tileRequestsBefore = gsiTileRequests;
  const points = Array.from({ length: 12 }, (_, index) =>
    Cartographic.fromDegrees(139.92 + index * 3e-4, 35.61 + index * 2e-4)
  );
  pagesDemTileRequests = 0;
  const sampled = await terrain.sampleWorldTerrainNeutral(points, undefined, "10m");
  // 端末への保存用タイル（バックグラウンド）もサーバー経由で取得されるまで待つ。
  const deviceTiles = await import("../../src/cesium/gsiDemTileCache.ts");
  await deviceTiles.flushGsiDeviceTilePrefetchQueue();
  assert.equal(pagesElevationRequests, 1, "the server must be asked first");
  assert.ok(pagesDemTileRequests >= 1, "tiles saved to the device also come from the server first");
  assert.equal(gsiTileRequests, tileRequestsBefore, "device-direct GSI must not run while the server answers");
  for (const sample of sampled) assert.equal(terrain.terrainDataSource(sample), "GSI_DEM10B_CONTOUR");
});

test("terrain sampling succeeds with Pages Functions completely unavailable", async () => {
  const { Cartographic } = await import("cesium");
  const terrain = await import("../../src/cesium/worldTerrain.ts");
  client.__resetGsiElevationServerBreakerForTesting();
  pagesMode = "fail";
  pagesElevationRequests = 0;
  const points = Array.from({ length: 40 }, (_, index) =>
    Cartographic.fromDegrees(139.81 + index * 2e-4, 35.71 + index * 1e-4)
  );
  const sampled = await terrain.sampleWorldTerrainNeutral(points, undefined, "10m");
  for (const sample of sampled) {
    assert.equal(terrain.terrainDataSource(sample), "GSI_DEM10B_CONTOUR");
    assert.ok(Number.isFinite(sample.height));
  }
  assert.equal(pagesElevationRequests, 1, "one server attempt, then the breaker and device-direct fallback");
  const again = await terrain.sampleWorldTerrainNeutral(
    [Cartographic.fromDegrees(139.83, 35.72)], undefined, "10m"
  );
  assert.equal(terrain.terrainDataSource(again[0]), "GSI_DEM10B_CONTOUR");
  assert.equal(pagesElevationRequests, 1, "while the breaker is open the server is skipped immediately");
});
