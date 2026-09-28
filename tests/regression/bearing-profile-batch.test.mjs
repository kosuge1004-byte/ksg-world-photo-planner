import assert from "node:assert/strict";
import test from "node:test";

import {
  computeBearingProfileBatch,
  isBearingProfileBatchRequest,
  lookupBearingProfileGeoidHeights,
} from "../../server/bearingProfileBatch.ts";
import { fetchBearingProfileBatch } from "../../src/cache/bearingProfileBatchClient.ts";
import { calculateKarneyDestinationPoint } from "../../src/geodesy/karneyGeodesic.ts";
import { lookupLocalJpgeo2024Height } from "../../server/jpgeo2024Local.ts";

const request = {
  subjectPoint: { latitude: 35.36, longitude: 136.81, height: 100 },
  cameraSettings: { lensCenterHeightMeters: 1.6 },
  bearings: [0, 90],
  maxDistanceMeters: 1_000,
};

test("bearing batch preserves every coordinate, detail and neutral interpolation", async () => {
  const elevationRequests = [];
  let geoidPointCount = 0;
  const result = await computeBearingProfileBatch(request, undefined, {
    lookupElevations: async (points) => {
      elevationRequests.push(...points);
      return points.map((_point, index) => index === 0
        ? { heightMeters: null, source: null }
        : { heightMeters: 100, source: "DEM5A" });
    },
    lookupGeoidHeights: async (points) => {
      geoidPointCount += points.length;
      return points.map(() => 38);
    },
    nowIso: () => "2026-09-26T00:00:00.000Z",
  });

  assert.equal(result.version, 2);
  assert.equal(result.requestedBearingCount, 2);
  assert.equal(result.failedBearings.length, 0);
  assert.equal(result.profiles.length, 2);
  assert.equal(result.pointCount, elevationRequests.length);
  assert.equal(geoidPointCount, result.pointCount,
    "every terrain coordinate must retain its point-specific geoid value");
  assert.ok(elevationRequests.every((point) =>
    point.maximumDetail === "1m" && point.interpolationMode === "neutral"
  ));

  assert.equal("points" in result.profiles[0], false,
    "wire response must not repeat coordinates for every point");
  const expanded = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(result)
  );
  assert.ok(expanded);
  const first = expanded.profiles[0].points[0];
  const expected = calculateKarneyDestinationPoint(
    request.subjectPoint,
    request.bearings[0],
    first.distanceMeters
  );
  assert.equal(first.latitude, expected.latitude);
  assert.equal(first.longitude, expected.longitude);
  assert.equal(first.ellipsoidalHeightMeters, 38,
    "authoritative DEM no-data remains the existing H=0 water convention");
  assert.equal(first.elevationSource, null);
  assert.ok(expanded.profiles.flatMap((profile) => profile.points).slice(1)
    .every((point) => point.ellipsoidalHeightMeters === 138));
  assert.ok(expanded.profiles.flatMap((profile) => profile.points).slice(1)
    .every((point) => point.elevationSource === "DEM5A"));
  let elevationRequestIndex = 0;
  for (const profile of expanded.profiles) {
    profile.points.forEach((point) => {
      const reconstructed = calculateKarneyDestinationPoint(
        request.subjectPoint,
        profile.bearingDegrees,
        point.distanceMeters
      );
      assert.equal(point.latitude, reconstructed.latitude);
      assert.equal(point.longitude, reconstructed.longitude);
      assert.equal(point.latitude, elevationRequests[elevationRequestIndex].latitude);
      assert.equal(point.longitude, elevationRequests[elevationRequestIndex].longitude);
      elevationRequestIndex += 1;
    });
  }
  assert.equal(elevationRequestIndex, elevationRequests.length);

  const rollingDeployV1 = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(expanded)
  );
  assert.deepEqual(rollingDeployV1, expanded,
    "the client must retain compatibility with a previously deployed v1 endpoint");
});

test("a complete precomputed profile bypasses every DEM and geoid calculation", async () => {
  const distancesMeters = [8, request.maxDistanceMeters];
  const precomputed = {
    version: 2,
    distancesMeters,
    profiles: request.bearings.map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [101.25, 102.5],
      elevationSources: ["DEM1A", "DEM5A"],
      computedAtIso: "2026-09-28T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: request.bearings.length,
    pointCount: request.bearings.length * distancesMeters.length,
  };
  let precomputedLookups = 0;
  const result = await computeBearingProfileBatch(request, undefined, {
    lookupPrecomputed: async (actualRequest) => {
      precomputedLookups += 1;
      assert.deepEqual(actualRequest, request);
      return precomputed;
    },
    lookupElevations: async () => { throw new Error("DEM must not run"); },
    lookupGeoidHeights: async () => { throw new Error("geoid must not run"); },
    nowIso: () => "unreachable",
  });
  assert.equal(precomputedLookups, 1);
  assert.deepEqual(result, precomputed);
});

test("production batch geoid path uses each original JPGEO2024 coordinate", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Japanese batch geoid lookup must not use the legacy CGI");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // This is the largest observed exact-vs-former-regional difference in the
  // 50 km Tokyo audit. It protects against accidentally restoring the old
  // 0.025° representative plus 0.01° rounding path.
  const point = { latitude: 35.713146785509316, longitude: 139.93724305019094 };
  const [actual] = await lookupBearingProfileGeoidHeights([point]);
  const exact = lookupLocalJpgeo2024Height(point.latitude, point.longitude);
  // The former algorithm reused the first point in this 0.025° region, then
  // rounded that representative to (35.74, 139.91) before interpolation.
  const formerRegional = lookupLocalJpgeo2024Height(35.74, 139.91);
  assert.equal(typeof exact, "number");
  assert.equal(typeof formerRegional, "number");
  assert.equal(actual, exact);
  assert.ok(Math.abs(exact - formerRegional) > 0.3,
    "the precision fixture must distinguish exact and former regional geoid heights");
});

test("batch geoid fallback keeps the original point-specific coordinate", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return Response.json({ OutputData: { geoidHeight: "12.3456" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const point = { latitude: 49.1234567, longitude: 159.1234567 };
  assert.deepEqual(await lookupBearingProfileGeoidHeights([point]), [12.3456]);
  assert.equal(requestedUrls.length, 1);
  const query = new URL(requestedUrls[0]).searchParams;
  assert.equal(query.get("latitude"), String(point.latitude));
  assert.equal(query.get("longitude"), String(point.longitude));
});

test("compact batch safely covers the full 360-bearing, 50 km contract", async () => {
  const fullRequest = {
    ...request,
    bearings: Array.from({ length: 360 }, (_, index) => index),
    maxDistanceMeters: 50_000,
  };
  let maximumElevationLookupPoints = 0;
  let geoidLookupCallCount = 0;
  let sourceIndex = 0;
  const sources = ["DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B", null];
  const result = await computeBearingProfileBatch(fullRequest, undefined, {
    lookupElevations: async (points) => {
      maximumElevationLookupPoints = Math.max(maximumElevationLookupPoints, points.length);
      return points.map((point) => {
        const source = sources[sourceIndex % sources.length];
        sourceIndex += 1;
        return {
          heightMeters: source === null
            ? null
            : Math.sin(point.latitude * 17 + point.longitude) * 9_999.123456789012,
          source,
        };
      });
    },
    lookupGeoidHeights: async (points) => {
      geoidLookupCallCount += 1;
      return points.map((point) =>
        Math.cos(point.latitude * 3 - point.longitude) * 80.123456789012
      );
    },
    nowIso: () => "2026-09-26T00:00:00.000Z",
  });

  assert.equal(result.version, 2);
  assert.equal(result.requestedBearingCount, 360);
  assert.equal(result.profiles.length, 360);
  assert.equal(result.pointCount, 360 * result.distancesMeters.length);
  assert.ok(maximumElevationLookupPoints <= 2_048);
  assert.ok(geoidLookupCallCount > 1,
    "360 bearings must be processed in bounded live-coordinate chunks");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024,
    "360-bearing response must remain compact enough for the Worker/browser boundary");
});

test("compact response keeps per-bearing failures and rejects incomplete envelopes", async () => {
  const failedResult = await computeBearingProfileBatch(request, undefined, {
    lookupElevations: async (points) => points.map((_point, index) => {
      return index < points.length / 2
        ? { heightMeters: 100, source: "DEM5A" }
        : { heightMeters: null, source: "DEM5A" };
    }),
    lookupGeoidHeights: async (points) => points.map(() => 38),
    nowIso: () => "2026-09-26T00:00:00.000Z",
  });
  assert.equal(failedResult.version, 2);
  assert.equal(failedResult.profiles.length, 1);
  assert.deepEqual(failedResult.failedBearings, [{
    bearingDegrees: 90,
    reason: "DEM標高の応答が不正な地点があります",
  }]);

  const expanded = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(failedResult)
  );
  assert.ok(expanded);
  assert.equal(expanded.profiles.length, 1);
  assert.deepEqual(expanded.failedBearings, failedResult.failedBearings);

  const incomplete = structuredClone(failedResult);
  incomplete.failedBearings = [];
  assert.equal(await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(incomplete)
  ), null, "an unaccounted bearing must fall back to the established direct path");
});

test("invalid or duplicate bearings are rejected before terrain work", () => {
  assert.equal(isBearingProfileBatchRequest(request), true);
  assert.equal(isBearingProfileBatchRequest({ ...request, bearings: [1, 1] }), false);
  assert.equal(isBearingProfileBatchRequest({ ...request, maxDistanceMeters: 50_001 }), false);
  assert.equal(isBearingProfileBatchRequest({
    ...request,
    subjectPoint: { ...request.subjectPoint, latitude: Number.NaN },
  }), false);
});

test("batch client falls back on an unavailable endpoint and preserves user abort", async () => {
  const unavailable = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => new Response("missing", { status: 404 })
  );
  assert.equal(unavailable, null);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchBearingProfileBatch(request, controller.signal, async () => {
      throw new Error("must not fetch");
    }),
    { name: "AbortError" }
  );
});
