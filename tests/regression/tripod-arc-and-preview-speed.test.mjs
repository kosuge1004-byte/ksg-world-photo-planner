import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildTripodCandidateRiseSetArc } from "../../src/cesium/tripodCandidateRiseSetArc.ts";
import { buildTripodSearchBaseLines } from "../../src/cesium/tripodSearchLine.ts";

test("ground base line follows the current celestial azimuth independently of tripod placement", () => {
  const subject = { latitude: 35, longitude: 138, height: 100, label: "subject" };
  const points = [{
    id: "moon",
    label: "月",
    azimuthDegrees: 10,
    altitudeDegrees: 25,
    xPercent: 50,
    yPercent: 50,
    visibleInFrame: false,
  }];
  const lines = buildTripodSearchBaseLines(
    subject,
    points,
    { sun: false, moon: true, milkyWay: false, polaris: false }
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "moon");
  assert.equal(lines[0].bearingDegrees, 190);
  const moved = buildTripodSearchBaseLines(
    subject,
    [{ ...points[0], azimuthDegrees: 20 }],
    { sun: false, moon: true, milkyWay: false, polaris: false }
  );
  assert.equal(moved[0].bearingDegrees, 200);
  assert.equal(
    buildTripodSearchBaseLines(
      subject,
      [{ ...points[0], altitudeDegrees: -5 }],
      { sun: false, moon: true, milkyWay: false, polaris: false }
    ).length,
    0
  );
});

test("confirmed tripod candidates remain points and are not joined by an extra legacy arc", async () => {
  const map2d = await readFile(new URL("../../src/components/Map2DOverlay.tsx", import.meta.url), "utf8");
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(map2d, /candidates\.map\(\(candidate\)/);
  assert.match(map2d, /map-tripod-candidate-marker/);
  assert.match(entities, /candidates\.forEach\(\(candidate, index\)/);
  assert.match(entities, /pixelSize:\s*15/);
  assert.doesNotMatch(map2d, /map-tripod-candidate-arc/);
  assert.doesNotMatch(entities, /三脚候補円弧/);
  assert.match(
    app,
    /updateTripodCandidateEntities\([\s\S]*?viewer,[\s\S]*?visibleCandidates,[\s\S]*?tripodCandidateRiseSetArcs/
  );
});

test("sun, moon and Milky Way rise-to-set guides stay inside the configured search range", async () => {
  const dayStart = new Date("2026-10-02T15:00:00.000Z"); // 2026-10-03 00:00 JST
  const dayEnd = new Date("2026-10-03T15:00:00.000Z");
  const gifuCastle = {
    latitude: 35.43392,
    longitude: 136.78215,
    height: 329,
    ellipsoidalHeightMeters: 329,
    label: "岐阜城",
  };
  for (const id of ["sun", "moon", "milkyWay"]) {
    const arc = buildTripodCandidateRiseSetArc({
      id,
      subject: gifuCastle,
      dayStart,
      dayEnd,
      lensCenterHeightMeters: 1.6,
      calculationMode: "pro",
      maxDistanceMeters: 10_000,
    });
    assert.ok(arc, `${id} arc`);
    assert.ok(arc.riseAt >= dayStart && arc.riseAt < dayEnd);
    assert.ok(arc.setAt > arc.riseAt);
    assert.ok(arc.points.length >= 2);
    assert.ok(arc.points.every((point) => point.id === id));
    assert.ok(arc.points.every((point) => point.solutionType === "preliminary"));
    assert.ok(arc.points.every((point) => point.distanceMeters <= 10_000));
  }

  const map2d = await readFile(new URL("../../src/components/Map2DOverlay.tsx", import.meta.url), "utf8");
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(map2d, /map-tripod-rise-set-arc/);
  assert.match(entities, /の出から入までの三脚候補線/);
  assert.match(app, /buildTripodCandidateRiseSetArc/);
  assert.match(app, /candidateRiseSetArcs=\{tripodCandidateRiseSetArcs\}/);
});

test("rise-set guides use half-width matching-color dashes and 3D adds the white camera sight line", async () => {
  const css = await readFile(new URL("../../src/App.css", import.meta.url), "utf8");
  const candidateEntities = await readFile(
    new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url),
    "utf8"
  );
  const sightLine = await readFile(
    new URL("../../src/cesium/tripodSubjectSightLineEntities.ts", import.meta.url),
    "utf8"
  );
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");

  assert.match(css, /\.map-tripod-rise-set-arc\s*\{[\s\S]*?stroke-width:\s*1\.25;[\s\S]*?stroke-dasharray:\s*6 4;/);
  assert.match(candidateEntities, /PolylineDashMaterialProperty/);
  assert.match(candidateEntities, /width:\s*1\.25/);
  assert.match(candidateEntities, /candidateColor\(arc\.id\)/);
  assert.match(sightLine, /Color\.WHITE\.withAlpha/);
  assert.match(sightLine, /PolylineDashMaterialProperty/);
  assert.match(sightLine, /ellipsoidalHeightMeters\(tripod\) \+ lensCenterHeightMeters/);
  assert.match(sightLine, /arcType:\s*ArcType\.NONE/);
  assert.match(app, /mapDisplayMode !== "3d"[\s\S]*?clearTripodSubjectSightLineEntity/);
  assert.match(app, /updateTripodSubjectSightLineEntity\([\s\S]*?subjectPoint,[\s\S]*?tripodPoint,[\s\S]*?cameraSettings\.lensCenterHeightMeters/);
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
