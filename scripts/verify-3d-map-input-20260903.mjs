import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

const placementGuard = /\{mapDisplayMode === "2d" &&\s*\(subjectPlacementActive \|\| tripodPlacementActive \|\| foregroundPlacementActive\) && \(/m;
const measurementGuard = /\{mapDisplayMode === "2d" && mapMeasuring && \(/m;

const checks = [
  [
    "2D placement overlay is never rendered over Cesium 3D",
    placementGuard.test(app),
  ],
  [
    "2D measurement overlay is also restricted to 2D",
    measurementGuard.test(app),
  ],
  [
    "Cesium 3D explicitly enables camera input",
    app.includes("viewer.scene.screenSpaceCameraController.enableInputs = true"),
  ],
  [
    "Cesium host accepts pointer input in 3D",
    app.includes('mapRef.current.style.pointerEvents = "auto"'),
  ],
  [
    "3D renderer CSS accepts pointer events",
    /\.map-3d-stage-host \.preview-renderer\s*\{[^}]*pointer-events:\s*auto;/s.test(css),
  ],
  [
    "full-screen 2D placement overlay still covers the map only when intentionally rendered",
    /\.map-2d-placement-layer\s*\{[^}]*z-index:\s*30;[^}]*inset:\s*0;/s.test(css),
  ],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}

if (failed) process.exit(1);
console.log(`PASS: ${checks.length}/${checks.length} checks`);
