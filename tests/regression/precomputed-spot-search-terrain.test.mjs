import assert from "node:assert/strict";
import test from "node:test";

import { Cartographic, Math as CesiumMath } from "cesium";

import { createPrecomputedSpotSearchTerrainSampler } from "../../server/precomputedSpotSearchTerrain.ts";
import { calculateKarneyDestinationPoint } from "../../src/geodesy/karneyGeodesic.ts";

const subject = { latitude: 35, longitude: 137, height: 100, label: "subject" };
const distancesMeters = [8, 1_000, 10_000];
const response = {
  version: 2,
  precomputed: true,
  distancesMeters,
  profiles: Array.from({ length: 360 }, (_, bearingDegrees) => ({
    bearingDegrees,
    ellipsoidalHeightsMeters: distancesMeters.map(() => bearingDegrees),
    elevationSources: distancesMeters.map(() => "DEM1A"),
    computedAtIso: "2026-09-29T00:00:00.000Z",
  })),
  failedBearings: [],
  requestedBearingCount: 360,
  pointCount: 360 * distancesMeters.length,
};

function cartographicAt(bearing, distance) {
  const destination = calculateKarneyDestinationPoint(subject, bearing, distance);
  return Cartographic.fromDegrees(destination.longitude, destination.latitude, 0);
}

test("precomputed profile supplies only the 10m coarse pass", async () => {
  const exactCalls = [];
  const exactSampler = async (points, _signal, detail) => {
    exactCalls.push({ points: points.length, detail });
    return points.map((point) => {
      const result = Cartographic.clone(point);
      result.height = 999;
      return result;
    });
  };
  const sampler = createPrecomputedSpotSearchTerrainSampler(subject, response, exactSampler);
  const coarse = await sampler([cartographicAt(10.5, 500)], undefined, "10m");
  assert.ok(Math.abs(coarse[0].height - 10.5) < 1e-5,
    `adjacent bearings must be interpolated for coarse bracketing: ${coarse[0].height}`);
  assert.equal(exactCalls.length, 0);

  const precise = await sampler([cartographicAt(10.5, 500)], undefined, "1m");
  assert.equal(precise[0].height, 999);
  assert.deepEqual(exactCalls, [{ points: 1, detail: "1m" }],
    "every 1m refinement must retain the established exact sampler");
});

test("uncovered coarse points fall back without changing point order", async () => {
  let fallbackPoints = 0;
  const sampler = createPrecomputedSpotSearchTerrainSampler(
    subject,
    response,
    async (points) => {
      fallbackPoints += points.length;
      return points.map((point) => {
        const result = Cartographic.clone(point);
        result.height = 321;
        return result;
      });
    }
  );
  const covered = cartographicAt(20, 500);
  const uncovered = Cartographic.fromRadians(
    covered.longitude,
    covered.latitude,
    covered.height
  );
  const far = calculateKarneyDestinationPoint(subject, 20, 12_000);
  uncovered.longitude = CesiumMath.toRadians(far.longitude);
  uncovered.latitude = CesiumMath.toRadians(far.latitude);
  const result = await sampler([covered, uncovered], undefined, "10m");
  assert.equal(fallbackPoints, 1);
  assert.ok(Math.abs(result[0].height - 20) < 1e-5);
  assert.equal(result[1].height, 321);
});
