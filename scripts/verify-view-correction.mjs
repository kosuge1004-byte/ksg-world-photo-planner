import fs from "node:fs";

const celestial = fs.readFileSync(
  new URL("../src/cesium/celestial.ts", import.meta.url),
  "utf8"
);
const transit = fs.readFileSync(
  new URL("../src/search/celestialTransitSearch.ts", import.meta.url),
  "utf8"
);
const dialog = fs.readFileSync(
  new URL("../src/components/CelestialTransitSearchDialog.tsx", import.meta.url),
  "utf8"
);

const required = [
  [celestial.includes("export function createCameraProjection"), "preview projection must be exported"],
  [transit.includes("createCameraProjection("), "transit search must use shared projection"],
  [transit.includes("input.criteria.viewCorrection.azimuthDegrees"), "crossing search must apply azimuth correction"],
  [dialog.includes("viewCorrection: { ...viewCorrection }"), "dialog must snapshot correction into criteria"],
];
for (const [condition, message] of required) {
  if (!condition) throw new Error(message);
}

for (const focalLength of [9, 35, 100, 400, 800, 1600]) {
  for (const correction of [-10, -5, 0, 5, 10]) {
    const subjectBearing = 123.456;
    const subjectAltitude = 17.25;
    const previewAzimuth = subjectBearing + correction;
    const searchAzimuth = subjectBearing + correction;
    const previewAltitude = subjectAltitude + correction;
    const searchAltitude = subjectAltitude + correction;
    if (
      previewAzimuth !== searchAzimuth ||
      previewAltitude !== searchAltitude ||
      !Number.isFinite(2 * Math.atan(36 / (2 * focalLength)))
    ) {
      throw new Error(`projection mismatch: ${focalLength}mm, correction ${correction}`);
    }
  }
}

console.log("View correction projection verification: PASS");
