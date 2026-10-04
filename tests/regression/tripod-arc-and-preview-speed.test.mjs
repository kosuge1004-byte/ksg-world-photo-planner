import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  alignRiseSetArcToConfirmedCandidates,
  buildTripodCandidateRiseSetArc,
} from "../../src/cesium/tripodCandidateRiseSetArc.ts";
import { buildTripodSearchBaseLines } from "../../src/cesium/tripodSearchLine.ts";
import { selectFarthestVerifiedCandidate } from "../../src/cache/tripodBearingProfileManager.ts";

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

test("the exact current candidate is inserted into the same-time rise-set guide", () => {
  const arc = {
    id: "moon",
    riseAt: new Date("2026-10-03T00:00:00Z"),
    setAt: new Date("2026-10-03T03:00:00Z"),
    points: [0, 1, 2].map((hour) => ({
      id: "moon",
      label: "月",
      latitude: 35 + hour * 0.01,
      longitude: 138,
      height: 100,
      distanceMeters: 1_000 + hour,
      solutionType: "preliminary",
      timestampMilliseconds: Date.parse(`2026-10-03T0${hour}:00:00Z`),
    })),
  };
  const exact = {
    id: "moon",
    label: "月",
    latitude: 35.123456,
    longitude: 138.654321,
    height: 210,
    distanceMeters: 2_345,
    solutionType: "aligned",
  };
  const aligned = alignRiseSetArcToConfirmedCandidates(
    arc,
    [exact],
    new Date("2026-10-03T01:02:00Z")
  );
  assert.equal(aligned.points.length, 3);
  assert.ok(aligned.points.some((point) =>
    point.latitude === exact.latitude && point.longitude === exact.longitude
  ));
});

test("multiple cached intersections collapse to the same farthest candidate as the authoritative search", () => {
  const candidates = [837, 1_082, 897].map((distanceMeters, index) => ({
    id: "moon",
    label: "月",
    latitude: 35 + index * 0.001,
    longitude: 138,
    height: 100,
    distanceMeters,
    solutionType: "aligned",
    intersectionIndex: index + 1,
    intersectionCount: 3,
  }));
  const selected = selectFarthestVerifiedCandidate(candidates);
  assert.ok(selected);
  assert.equal(selected.distanceMeters, 1_082);
  assert.equal(selected.intersectionIndex, 1);
  assert.equal(selected.intersectionCount, 1);
});

test("rise-set guide inserts only one farthest point and ignores candidates outside its active date interval", () => {
  const arc = {
    id: "moon",
    riseAt: new Date("2026-10-04T15:00:00Z"),
    setAt: new Date("2026-10-05T05:30:00Z"),
    points: [0, 1, 2].map((hour) => ({
      id: "moon",
      label: "月",
      latitude: 35 + hour * 0.01,
      longitude: 138,
      height: 100,
      distanceMeters: 900,
      solutionType: "preliminary",
      timestampMilliseconds: Date.parse(`2026-10-04T${15 + hour}:00:00Z`),
    })),
  };
  const candidates = [837, 1_082, 897].map((distanceMeters, index) => ({
    id: "moon",
    label: "月",
    latitude: 36 + index * 0.01,
    longitude: 139,
    height: 110,
    distanceMeters,
    solutionType: "aligned",
  }));

  const aligned = alignRiseSetArcToConfirmedCandidates(
    arc,
    candidates,
    new Date("2026-10-04T16:08:00Z")
  );
  assert.equal(aligned.points.length, arc.points.length);
  assert.equal(
    aligned.points.filter((point) => point.distanceMeters === 1_082).length,
    1,
    "候補線へは最遠の現在候補1件だけを挿入する"
  );

  const outside = alignRiseSetArcToConfirmedCandidates(
    arc,
    candidates,
    new Date("2026-10-05T08:00:00Z")
  );
  assert.deepEqual(outside, arc, "月没後の古い候補で線を変形しない");
});

test("rise-set guides use thinner red dashes and 3D adds the white camera sight line", async () => {
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

  assert.match(css, /\.map-tripod-rise-set-arc\s*\{[\s\S]*?stroke:\s*rgba\(255, 42, 42, \.98\);[\s\S]*?stroke-width:\s*\.625;[\s\S]*?stroke-dasharray:\s*6 4;/);
  assert.match(candidateEntities, /PolylineDashMaterialProperty/);
  assert.match(candidateEntities, /width:\s*0\.625/);
  assert.match(candidateEntities, /Color\.RED\.withAlpha\(0\.98\)/);
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
  assert.match(app, /<CelestialOverlay[\s\S]*?tracks=\{\[\]\}/);
});

test("timeline commits its latest frame and timezone updates cannot restore an old timestamp", async () => {
  const timeline = await readFile(new URL("../../src/components/TimelinePanel.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(timeline, /const flushPendingTimelineTime = useCallback/);
  assert.match(timeline, /timelineDragRef\.current = null;\s*flushPendingTimelineTime\(\);\s*onInteractionChange\?\.\(false\)/);
  assert.match(timeline, /wheelIdleTimerRef\.current = null;\s*flushPendingTimelineTime\(\);/);
  assert.match(app, /const previousTimeZone = timeZoneRef\.current;[\s\S]*?dateFromZonedDateTimeLocal\(\s*dateTimeLocalRef\.current,[\s\S]*?previousTimeZone/);
});
