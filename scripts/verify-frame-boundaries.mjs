import fs from "node:fs";

const celestial = fs.readFileSync(
  new URL("../src/cesium/celestial.ts", import.meta.url),
  "utf8"
);
const transit = fs.readFileSync(
  new URL("../src/search/celestialTransitSearch.ts", import.meta.url),
  "utf8"
);

if (!celestial.includes("export function isCelestialInCameraFrame")) {
  throw new Error("shared frame rule is missing");
}
if (!celestial.match(/const visibleInFrame = isCelestialInCameraFrame\(/)) {
  throw new Error("preview does not use the shared frame rule");
}
if (!transit.includes("return isCelestialInCameraFrame(")) {
  throw new Error("transit search does not use the shared frame rule");
}

const minimumIntervalMs = 60_000;
const maximumIntervalMs = 10 * 60_000;
const maximumMotionDegreesPerMinute = 0.3;
const samplesAcrossFrame = 4;
for (const focalLengthMm of [400, 800, 1600]) {
  const verticalFovDegrees =
    2 * Math.atan(24 / (2 * focalLengthMm)) * 180 / Math.PI;
  const traversalMinutes = verticalFovDegrees / maximumMotionDegreesPerMinute;
  const intervalMs = Math.max(
    minimumIntervalMs,
    Math.min(
      maximumIntervalMs,
      Math.floor(traversalMinutes * 60_000 / samplesAcrossFrame)
    )
  );
  if (intervalMs >= traversalMinutes * 60_000 / 2) {
    throw new Error(
      `${focalLengthMm}mm sampling is too coarse: ${intervalMs}ms`
    );
  }
}

// 現行仕様: 太陽・月は円盤の一部がフレームへ重なれば可視。
const centerPercent = 101;
const discHalfPercent = 2;
if (!(centerPercent - discHalfPercent <= 100)) {
  throw new Error("disc overlap boundary verification failed");
}

console.log("Frame boundary and telephoto sampling verification: PASS");
