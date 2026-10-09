import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import { syntheticGsiTileResponse } from "./helpers/gsiSyntheticTiles.mjs";

globalThis.indexedDB = indexedDB;
globalThis.window ??= {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

let directElevationCalls = 0;
let serverUnreachable = false;
let siteContextCalls = 0;
let batchApiCalls = 0;
let gsiDirectTileRequests = 0;
let staticProfileCalls = 0;
/** 静的配信のファイル。null なら Pages の自動SPAフォールバック（index.html）を返す。 */
let staticProfileBody = null;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("/precomputed-bearing-profile-v1/")) {
    staticProfileCalls += 1;
    return staticProfileBody
      ? new Response(staticProfileBody, { headers: { "Content-Type": "application/gzip" } })
      : new Response("<!doctype html><title>AstroSight</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
  }
  if (url === "/api/bearing-profile-batch") {
    batchApiCalls += 1;
    return new Response("<!doctype html><title>AstroSight</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (url.includes("/api/osm-site-context") || url.includes("overpass")) {
    siteContextCalls += 1;
  }
  if (url.includes("/api/gsi-elevation")) {
    directElevationCalls += 1;
    // 2026-09-30: 2件目はサーバー（R2/Eドライブ/GSI）が応答しない状況を再現する。
    if (serverUnreachable) throw new TypeError("Failed to fetch");
  }
  // 2026-09-30: 任意座標の1方位経路は国土地理院から端末が直接取得する。
  const tile = syntheticGsiTileResponse(url);
  if (tile) {
    gsiDirectTileRequests += 1;
    return tile;
  }
  throw new Error(`unexpected direct request: ${url}`);
};

const { backfillBearingProfiles } = await import(
  "../../src/cache/tripodBearingProfileManager.ts"
);

// 2026-09-30: 契約変更。登録スポットは静的配信の計算済みファイル → API（R2 → Eドライブ）
// の順で取得し、どちらも得られなければ例外で終わらせず1方位経路で続行する。
test("a registered spot is served by the static precomputed file without any API call", async () => {
  const { gzipSync } = await import("node:zlib");
  const { densifyDistanceIntervals, logarithmicDistances, ABSOLUTE_MIN_DISTANCE_METERS, ADAPTIVE_COARSE_MAX_SPAN_METERS } =
    await import("../../src/cesium/tripodCandidates.ts");
  const { requiredCelestialTripodBearings } = await import("../../src/cache/tripodBearingProfileManager.ts");
  const skytree = { latitude: 35.7100627, longitude: 139.8107004 };
  const distances = densifyDistanceIntervals(
    logarithmicDistances({ minMeters: ABSOLUTE_MIN_DISTANCE_METERS, maxMeters: 10_000 }, 32),
    ADAPTIVE_COARSE_MAX_SPAN_METERS
  );
  const profiles = Array.from({ length: 360 }, (_, bearingDegrees) => ({
    bearingDegrees,
    computedAtIso: "2026-09-30T00:00:00.000Z",
    ellipsoidalHeightsMeters: distances.map(() => 40.25),
    elevationSources: distances.map(() => "DEM5A"),
  }));
  staticProfileBody = gzipSync(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-precomputed-bearing-profile-v1",
    subject: { name: "東京スカイツリー", ...skytree },
    maxDistanceMeters: 10_000,
    generatedAt: "2026-09-30T00:00:00.000Z",
    response: {
      version: 2, precomputed: true, distancesMeters: distances, profiles,
      failedBearings: [], requestedBearingCount: 360, pointCount: 360 * distances.length,
    },
  })));
  batchApiCalls = 0;
  directElevationCalls = 0;
  const result = await backfillBearingProfiles({
    subjectId: "registered-static",
    subjectPoint: { ...skytree, height: 672, label: "東京スカイツリー" },
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 10_000,
  });
  staticProfileBody = null;
  assert.equal(result.aborted, false);
  assert.equal(result.requestedBearings, requiredCelestialTripodBearings(skytree.latitude).length);
  assert.equal(result.successfulBearings, result.requestedBearings);
  assert.equal(staticProfileCalls >= 1, true);
  assert.equal(batchApiCalls, 0, "the static file must be used before the Pages Functions API");
  assert.equal(directElevationCalls, 0);
});

test("a registered spot continues on the per-bearing path when the static file and API both fail", async () => {
  batchApiCalls = 0;
  directElevationCalls = 0;
  const controller = new AbortController();
  let reason = null;
  const running = backfillBearingProfiles({
    subjectId: "registered-html-error",
    subjectPoint: {
      latitude: 35.7100627,
      longitude: 139.8107004,
      height: 672,
      label: "東京スカイツリー",
    },
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 10_000,
    signal: controller.signal,
    onProgress(progress) {
      if (progress.directFallbackNotice) {
        reason = progress.directFallbackNotice;
        // 1方位経路に入ったことを確認したら、10km全方位の計算は待たずに止める。
        controller.abort();
      }
    },
  });
  const outcome = await running.then((value) => value, (error) => error);
  assert.notEqual(outcome?.name, "PrecomputedBearingProfileUnavailableError",
    "a registered spot must no longer end the download with an error");
  assert.ok(batchApiCalls >= 1, "the API is tried after the static file");
  assert.equal(typeof reason, "string", "the per-bearing path must start");
  // 2026-10-09: 内部の理由は画面の文章に出さない。
  assert.match(reason, /^計算済みデータを使えないため、1方位ずつ直接取得しています。/);
  assert.doesNotMatch(reason, /静的配信|理由/);
});

// 2026-09-30: 契約変更。旧1方位経路は全点をPages Functions経由で取得し約54分
// かかったため、任意座標では開始しない方針だった。現在の1方位経路は
// 端末内 → R2 → Eドライブ → 国土地理院（サーバー経由）→ 国土地理院（端末から直接）
// の順で取得し、サーバーが応答しなくても完了しなければならない。
test("arbitrary coordinates try the server first, then complete via device-direct GSI when it is unreachable", async () => {
  serverUnreachable = true;
  const result = await backfillBearingProfiles({
    subjectId: "nearby-device-direct",
    subjectPoint: {
      latitude: 35.7101127,
      longitude: 139.8107504,
      height: 12,
      label: "押上の任意地点",
    },
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 1_000,
  });
  assert.equal(result.aborted, false);
  assert.ok(result.requestedBearings > 0);
  assert.equal(result.successfulBearings, result.requestedBearings);
  assert.equal(result.failedBearings, 0);
  assert.ok(directElevationCalls >= 1, "the server path (R2/E-drive) must be attempted first");
  assert.ok(directElevationCalls <= 3, "an unreachable server must not be retried per bearing");
  // 2026-09-30: 水面・道路・建物情報はダウンロード対象外。
  assert.equal(siteContextCalls, 0, "the download must not query water/road/building data");
  assert.equal("ancillaryFailures" in result, false);
});
