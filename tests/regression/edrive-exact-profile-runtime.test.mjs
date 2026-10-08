import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

import { computeBearingProfileBatch } from "../../server/bearingProfileBatch.ts";
import { getBearingProfilesMany } from "../../src/cache/tripodBearingProfileCache.ts";

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

const siteContext = {
  walkingAccessible: true,
  onMappedWay: true,
  restrictedAccess: false,
  onMotorRoad: false,
  onWaterSurface: false,
  waterSurfaceKind: "none",
  nearbyLandmarks: [],
  nearbyBuildings: [],
  nearbyStructures: [],
};

let batchCalls = 0;
let maximumBearingsPerCall = 0;
let legacyElevationCalls = 0;
let demTileCalls = 0;
let failAtBatchCalls = new Set();
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === "/api/bearing-profile-batch") {
    batchCalls += 1;
    if (failAtBatchCalls.has(batchCalls)) {
      return Response.json({
        code: "LOCAL_DEM_PROFILE_UNAVAILABLE",
        error: "Eドライブ一時停止",
      }, { status: 503 });
    }
    const request = JSON.parse(init.body);
    maximumBearingsPerCall = Math.max(maximumBearingsPerCall, request.bearings.length);
    const response = await computeBearingProfileBatch(request, init.signal, {
      lookupPrecomputed: async () => null,
      lookupElevations: async (points) => points.map(() => ({
        heightMeters: 100,
        source: "DEM5A",
      })),
      lookupGeoidHeights: async (points) => points.map(() => 38),
      nowIso: () => "2026-09-30T00:00:00.000Z",
    });
    response.terrainProfileComplete = true;
    return Response.json(response);
  }
  if (url.startsWith("/api/gsi-elevation")) {
    legacyElevationCalls += 1;
    throw new Error("exact E-drive profile must not use the legacy device path");
  }
  if (url.startsWith("/api/gsi-dem-tile")) {
    demTileCalls += 1;
    throw new Error("complete E-drive profile must not redownload raw tiles on the device");
  }
  if (url.startsWith("/api/osm-site-context")) {
    const request = JSON.parse(init.body);
    return Response.json({ contexts: request.points.map(() => ({ ...siteContext })) });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const manager = await import("../../src/cache/tripodBearingProfileManager.ts");

test("arbitrary exact coordinates use bounded E-drive batches and never the 54-minute path", async () => {
  const subjectPoint = {
    latitude: 35.7101127,
    longitude: 139.8107504,
    height: 12,
    geoidHeightMeters: 38,
    label: "押上の任意地点",
  };
  const bearings = manager.requiredCelestialTripodBearings(subjectPoint.latitude);
  const result = await manager.backfillBearingProfiles({
    subjectId: "edrive-exact-runtime",
    subjectPoint,
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 10_000,
  });

  assert.equal(result.requestedBearings, bearings.length);
  assert.equal(result.successfulBearings, bearings.length);
  assert.equal(result.failedBearings, 0);
  assert.equal(batchCalls, Math.ceil(bearings.length / 120));
  assert.equal(maximumBearingsPerCall, 120);
  assert.equal(legacyElevationCalls, 0);
  assert.equal(demTileCalls, 0);
});

test("a retry resumes after the last committed E-drive chunk", async () => {
  batchCalls = 0;
  maximumBearingsPerCall = 0;
  // The 120-bearing request fails first, then its first safe 24-bearing retry
  // fails as well. This reaches the existing direct fallback only after the
  // adaptive split has proved that the origin is unavailable.
  failAtBatchCalls = new Set([2, 3]);
  const subjectPoint = {
    latitude: 35.7111127,
    longitude: 139.8117504,
    height: 12,
    geoidHeightMeters: 38,
    label: "押上の別地点",
  };
  const bearings = manager.requiredCelestialTripodBearings(subjectPoint.latitude);
  // 2026-09-30: Eドライブが途中で止まっても例外で終わらせず、残り方位は1方位経路で
  // 続行する契約に変更。ここでは1方位経路へ入った時点で利用者が中止した場合に、
  // 確定済みの一括チャンクから再開できることを検証する。
  const controller = new AbortController();
  let fallbackNotice = null;
  await assert.rejects(manager.backfillBearingProfiles({
    subjectId: "edrive-resume-runtime",
    subjectPoint,
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 10_000,
    signal: controller.signal,
    onProgress(progress) {
      if (progress.directFallbackNotice) {
        fallbackNotice = progress.directFallbackNotice;
        controller.abort();
      }
    },
  }).then((result) => {
    if (result.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return result;
  }), { name: "AbortError" });
  assert.match(fallbackNotice, /Eドライブ一時停止/, "the E-drive miss reason is shown on the per-bearing path");
  assert.equal(batchCalls, 3);
  assert.equal(legacyElevationCalls, 0);

  batchCalls = 0;
  failAtBatchCalls = new Set();
  const resumed = await manager.backfillBearingProfiles({
    subjectId: "edrive-resume-runtime",
    subjectPoint,
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 10_000,
  });
  assert.equal(resumed.requestedBearings, bearings.length - 120);
  assert.equal(resumed.successfulBearings, bearings.length - 120);
  assert.equal(resumed.failedBearings, 0);
  assert.equal(batchCalls, Math.ceil((bearings.length - 120) / 120));
  const completedProfiles = await getBearingProfilesMany(
    "edrive-resume-runtime",
    1.6,
    bearings,
  );
  assert.equal(completedProfiles.filter(Boolean).length, bearings.length);
  assert.equal(legacyElevationCalls, 0);
  assert.equal(demTileCalls, 0);
});

test("an oversized miss is recovered by safe chunks before any direct fallback", async () => {
  batchCalls = 0;
  maximumBearingsPerCall = 0;
  failAtBatchCalls = new Set([1]);
  const subjectPoint = {
    latitude: 35.7121127,
    longitude: 139.8127504,
    height: 12,
    geoidHeightMeters: 38,
    label: "押上の分割確認地点",
  };
  const bearings = manager.requiredCelestialTripodBearings(subjectPoint.latitude);
  let fallbackNotice = null;
  const result = await manager.backfillBearingProfiles({
    subjectId: "edrive-adaptive-split-runtime",
    subjectPoint,
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 10_000,
    onProgress(progress) {
      fallbackNotice ||= progress.directFallbackNotice ?? null;
    },
  });
  assert.equal(result.successfulBearings, bearings.length);
  assert.equal(result.failedBearings, 0);
  assert.equal(fallbackNotice, null);
  assert.equal(maximumBearingsPerCall, 120);
  assert.equal(legacyElevationCalls, 0);
  assert.equal(demTileCalls, 0);
});
