import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

import { computeBearingProfileBatch } from "../../server/bearingProfileBatch.ts";

globalThis.indexedDB = indexedDB;
globalThis.window ??= {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
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
let legacyElevationCalls = 0;
let legacyGeoidCalls = 0;
let demTileCalls = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === "/api/bearing-profile-batch") {
    batchCalls += 1;
    const request = JSON.parse(init.body);
    const response = await computeBearingProfileBatch(request, init.signal, {
      lookupElevations: async (points) => points.map(() => ({
        heightMeters: 100,
        source: "DEM5A",
      })),
      lookupGeoidHeights: async (points) => points.map(() => 38),
      nowIso: () => "2026-09-26T00:00:00.000Z",
    });
    response.precomputed = true;
    return Response.json(response);
  }
  if (url.startsWith("/api/gsi-elevation")) {
    legacyElevationCalls += 1;
    throw new Error("batch-success path must not use legacy per-bearing elevation calls");
  }
  if (url.startsWith("/api/gsi-geoid")) {
    legacyGeoidCalls += 1;
    throw new Error("batch-success path must not use legacy per-bearing geoid calls");
  }
  if (url.startsWith("/api/gsi-dem-tile")) {
    demTileCalls += 1;
    return new Response(null, { status: 404 });
  }
  if (url.startsWith("/api/osm-site-context")) {
    const request = JSON.parse(init.body);
    return Response.json({ contexts: request.points.map(() => ({ ...siteContext })) });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const manager = await import("../../src/cache/tripodBearingProfileManager.ts");

test("manager downloads every registered-spot bearing in one published-profile request", async () => {
  const subjectPoint = {
    latitude: 35.36,
    longitude: 136.81,
    height: 100,
    geoidHeightMeters: 38,
  };
  const bearings = manager.requiredCelestialTripodBearings(subjectPoint.latitude);
  const result = await manager.backfillBearingProfiles({
    subjectId: "batch-runtime",
    subjectPoint,
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
    maxDistanceMeters: 1_000,
  });

  assert.equal(result.requestedBearings, bearings.length);
  assert.equal(result.successfulBearings, bearings.length);
  assert.equal(result.failedBearings, 0);
  assert.equal(batchCalls, 1);
  assert.equal(legacyElevationCalls, 0);
  assert.equal(legacyGeoidCalls, 0);
  assert.equal(demTileCalls, 0,
    "the complete published profile must not redownload the same raw DEM tiles");

  const { getBearingProfilesMany } = await import("../../src/cache/tripodBearingProfileCache.ts");
  const profiles = await getBearingProfilesMany("batch-runtime", 1.6, bearings);
  assert.ok(profiles.every((profile) => profile !== null));
  assert.ok(profiles.every((profile) =>
    profile.points.every((point) => point.ellipsoidalHeightMeters === 138)
  ));
});
