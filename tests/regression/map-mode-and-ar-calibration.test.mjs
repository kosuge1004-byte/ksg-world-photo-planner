import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { orientationOffsetFromSwipe } from "../../src/ar/orientationCalibration.ts";

test("AR swipe calibration uses exact Camera2 field of view when available", () => {
  assert.deepEqual(orientationOffsetFromSwipe({
    startX: 0,
    startY: 0,
    currentX: 500,
    currentY: 250,
    stageWidth: 1_000,
    stageHeight: 500,
    startOffset: { headingOffsetDegrees: 5, pitchOffsetDegrees: -2 },
    projection: { horizontalFovDeg: 60, verticalFovDeg: 40 },
  }), {
    headingOffsetDegrees: -25,
    pitchOffsetDegrees: -22,
  });
});

test("AR swipe calibration remains active when Camera2 metadata is unavailable", () => {
  const result = orientationOffsetFromSwipe({
    startX: 100,
    startY: 100,
    currentX: 600,
    currentY: 100,
    stageWidth: 1_000,
    stageHeight: 500,
    startOffset: { headingOffsetDegrees: 0, pitchOffsetDegrees: 0 },
    projection: null,
  });
  assert.equal(result.headingOffsetDegrees, -30);
  assert.equal(result.pitchOffsetDegrees, 0);
});

test("lower map exposes the same 2D/3D toggle in both display modes", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /className="map-display-mode-toggle"/);
  assert.match(source, /mapDisplayMode === "2d" \? "3D" : "2D"/);
  assert.match(source, /toggleMapDisplayMode\(\)/);
});

test("lower 2D and 3D maps are mutually exclusive and stop the inactive engine", async () => {
  const appSource = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const mapLibreSource = await readFile(new URL("../../src/components/MapLibre2DMap.tsx", import.meta.url), "utf8");

  // The ternary mounts exactly one lower-map engine. React unmounts MapLibre
  // before the Cesium host is mounted, and mounts a fresh MapLibre map on return.
  assert.match(
    appSource,
    /\{mapDisplayMode === "2d" \? \(\s*<MapLibre2DMap[\s\S]*?\) : \(\s*[\s\S]*?<div ref=\{map3DHostRef\} className="map-3d-stage-host" \/>/
  );
  assert.match(mapLibreSource, /mapRef\.current\?\.remove\(\)/);

  // Cesium has no default loop. Its lower-map RAF exists only in 3D mode and
  // is cancelled as soon as the switch returns to 2D.
  assert.match(appSource, /viewer\.useDefaultRenderLoop = false/);
  assert.match(appSource, /if \(mapDisplayMode !== "3d"\) return;/);
  assert.match(appSource, /cancelAnimationFrame\(rafId\)/);
});
