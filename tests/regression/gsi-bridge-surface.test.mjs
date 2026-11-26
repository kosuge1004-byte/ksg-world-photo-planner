import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bridgeSurfaceContextForPreparedLines,
  resolveBridgeDeckOrthometricHeight,
} from "../../server/gsiBridgeSurface.ts";
import { computeBearingProfileBatch } from "../../server/bearingProfileBatch.ts";

test("GSI bridge centreline selects only the road width and preserves the true span fraction", () => {
  const line = {
    bridgeKey: "14/1/2/road/3/0",
    points: [
      { latitude: 35, longitude: 135 },
      { latitude: 35, longitude: 135.001 },
    ],
    halfWidthMeters: 4,
    clippedAtTileBoundary: false,
  };
  const middle = bridgeSurfaceContextForPreparedLines(
    { latitude: 35, longitude: 135.0005 },
    [line]
  );
  assert.ok(middle);
  assert.ok(Math.abs(middle.positionFraction - 0.5) < 0.001);
  assert.ok(middle.centerlineDistanceMeters < 0.01);
  assert.equal(middle.startOutsidePoints.length, 3);
  assert.equal(middle.endOutsidePoints.length, 3);
  assert.ok(middle.startOutsidePoints.every((point) => point.longitude < 135));
  assert.ok(middle.endOutsidePoints.every((point) => point.longitude > 135.001));

  assert.equal(
    bridgeSurfaceContextForPreparedLines(
      { latitude: 35.0001, longitude: 135.0005 },
      [line]
    ),
    null,
    "a nearby river/road coordinate outside the bridge width is not reclassified"
  );
  assert.equal(
    bridgeSurfaceContextForPreparedLines(
      { latitude: 35, longitude: 135.0005 },
      [{ ...line, clippedAtTileBoundary: true }]
    ),
    null,
    "a tile-clipped span is rejected instead of inventing bridge endpoints"
  );
});

test("bridge deck uses the two approach medians and a slope, while retaining existing deck DEM", () => {
  assert.equal(resolveBridgeDeckOrthometricHeight({
    existingHeightMeters: 0,
    startApproachHeightsMeters: [100, 101, 102],
    endApproachHeightsMeters: [200, 201, 202],
    positionFraction: 0.25,
  }), 126);
  assert.equal(resolveBridgeDeckOrthometricHeight({
    existingHeightMeters: 126.75,
    startApproachHeightsMeters: [100, 101, 102],
    endApproachHeightsMeters: [200, 201, 202],
    positionFraction: 0.25,
  }), 126.75, "existing bridge elevation within one metre is retained exactly");
  assert.equal(resolveBridgeDeckOrthometricHeight({
    existingHeightMeters: 250,
    startApproachHeightsMeters: [100, 101, 102],
    endApproachHeightsMeters: [200, 201, 202],
    positionFraction: 0.25,
  }), 250, "an existing arched/high deck is not flattened to the approach grade");
  assert.equal(resolveBridgeDeckOrthometricHeight({
    existingHeightMeters: 0,
    startApproachHeightsMeters: [],
    endApproachHeightsMeters: [200],
    positionFraction: 0.5,
  }), null, "one missing approach cannot be guessed");
});

test("exact red-line batch applies the same bridge deck slope before adding the geoid", async () => {
  let elevationCall = 0;
  const result = await computeBearingProfileBatch({
    subjectPoint: { latitude: 35.36, longitude: 136.81, height: 100 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [90],
    maxDistanceMeters: 1_000,
  }, undefined, {
    lookupElevations: async (points) => {
      elevationCall += 1;
      return points.map((point) => {
        if (point.latitude === 34) return { heightMeters: 100, source: "DEM1A" };
        if (point.latitude === 36) return { heightMeters: 200, source: "DEM1A" };
        return { heightMeters: null, source: null };
      });
    },
    lookupGeoidHeights: async (points) => points.map(() => 37),
    lookupBridgeContexts: async (points) => points.map((_point, index) => index === 0 ? {
      bridgeKey: "fixture-bridge",
      positionFraction: 0.25,
      centerlineDistanceMeters: 0,
      startOutsidePoints: [
        { latitude: 34, longitude: 136 },
        { latitude: 34, longitude: 136.1 },
        { latitude: 34, longitude: 136.2 },
      ],
      endOutsidePoints: [
        { latitude: 36, longitude: 136 },
        { latitude: 36, longitude: 136.1 },
        { latitude: 36, longitude: 136.2 },
      ],
    } : null),
    nowIso: () => "2026-11-26T00:00:00.000Z",
  });
  assert.ok(elevationCall >= 2, "profile DEM and bridge approaches are both sampled");
  assert.equal(result.failedBearings.length, 0);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].ellipsoidalHeightsMeters[0], 162,
    "orthometric 125 m deck + point-specific 37 m geoid");
  assert.equal(result.profiles[0].elevationSources[0], "DEM1A");
  assert.ok(result.profiles[0].ellipsoidalHeightsMeters.slice(1).every((height) => height === 37));
});

test("browser candidate, background search, and E-drive exact line all use bridge support", async () => {
  const [candidates, background, localOrigin] = await Promise.all([
    readFile(new URL("../../src/cesium/tripodCandidates.ts", import.meta.url), "utf8"),
    readFile(new URL("../../server/runSpotSearchJob.ts", import.meta.url), "utf8"),
    readFile(new URL("../../tools/local-dem-server/server.ts", import.meta.url), "utf8"),
  ]);
  assert.match(candidates, /terrainSampler: TerrainSampler = sampleTripodSupportSurface/);
  assert.match(candidates, /bridgeSupportSurface[\s\S]*?mappedWaterSurfaceKind === "river"/);
  assert.match(background, /sampleServerTripodSupportSurface/);
  assert.match(localOrigin, /lookupBridgeContexts: lookupGsiBridgeSurfaceContexts/);
});
