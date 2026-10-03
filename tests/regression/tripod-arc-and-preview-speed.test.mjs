import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { orderTripodCandidatesForArc } from "../../src/cesium/tripodCandidateArc.ts";
import { calculateKarneyDestinationPoint } from "../../src/geodesy/karneyGeodesic.ts";

const subject = {
  latitude: 35,
  longitude: 138,
  height: 100,
  label: "subject",
};

function candidateAt(bearingDegrees, distanceMeters, id) {
  const point = calculateKarneyDestinationPoint(subject, bearingDegrees, distanceMeters);
  return {
    id,
    label: id,
    latitude: point.latitude,
    longitude: point.longitude,
    height: 100,
    distanceMeters,
    solutionType: "aligned",
  };
}

test("candidate arc crosses north through the short side instead of wrapping around the map", () => {
  const ordered = orderTripodCandidatesForArc(subject, [
    candidateAt(10, 1_000, "sun"),
    candidateAt(350, 1_100, "moon"),
    candidateAt(0, 900, "milkyWay"),
  ]);
  assert.deepEqual(ordered.map((point) => Math.round(point.bearingFromSubjectDegrees)), [350, 0, 10]);
});

test("2D and 3D render the same confirmed candidate arc without changing candidate coordinates", async () => {
  const map2d = await readFile(new URL("../../src/components/Map2DOverlay.tsx", import.meta.url), "utf8");
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(map2d, /className="map-tripod-candidate-arc"/);
  assert.match(entities, /name: "三脚候補円弧"/);
  assert.match(entities, /clampToGround: hasTerrainGlobe/);
  assert.match(entities, /Cartesian3\.fromDegreesArrayHeights/);
  assert.match(app, /updateTripodCandidateEntities\(viewer, visibleCandidates, subjectPoint\)/);
});

test("downloaded bearing profiles are read in one transaction before exact refinement", async () => {
  const manager = await readFile(new URL("../../src/cache/tripodBearingProfileManager.ts", import.meta.url), "utf8");
  assert.match(manager, /const profiles = await getBearingProfilesMany\(/);
  assert.doesNotMatch(manager, /await getBearingProfile\(/);
  assert.match(manager, /calculateTripodCandidates\(/);
});

test("upper preview is progressive, bounded to six seconds, and keeps its preview camera warm", async () => {
  const preview = await readFile(new URL("../../src/cesium/previewSnapshot.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const viewer = await readFile(new URL("../../src/cesium/createMapViewer.ts", import.meta.url), "utf8");

  assert.match(preview, /PREVIEW_INITIAL_TILE_WAIT_TIMEOUT_MS = 4_000/);
  assert.match(preview, /PREVIEW_REFINEMENT_TILE_WAIT_TIMEOUT_MS = 2_000/);
  assert.match(preview, /PREVIEW_FRAME_COPY_INTERVAL_MS = 240/);
  assert.match(app, /PREVIEW_INITIAL_TILE_WAIT_TIMEOUT_MS/);
  assert.match(app, /PREVIEW_REFINEMENT_TILE_WAIT_TIMEOUT_MS/);
  assert.match(app, /tileWaitTimeoutMs,[\s\S]*?false\s*\)/);
  assert.match(viewer, /viewer\.terrainProvider = terrainProvider/);
  assert.match(app, /heightMeters: mapDisplayModeRef\.current === "3d" \? 1_200 : 2_000_000/);
});
