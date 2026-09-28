import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { lookupLocalJpgeo2024Height } from "../server/jpgeo2024Local.ts";

const references = [
  { name: "Tokyo", latitude: 35.681236, longitude: 139.767125, legacyCgiMeters: 36.7614 },
  { name: "Osaka", latitude: 34.702485, longitude: 135.495951, legacyCgiMeters: 37.5925 },
  { name: "Sapporo", latitude: 43.068661, longitude: 141.350755, legacyCgiMeters: 32.1957 },
  { name: "Fukuoka", latitude: 33.590355, longitude: 130.401716, legacyCgiMeters: 32.5869 },
  { name: "Naha", latitude: 26.212401, longitude: 127.680932, legacyCgiMeters: 30.8471 },
];

const points = references.map((point) => {
  const localMeters = lookupLocalJpgeo2024Height(point.latitude, point.longitude);
  assert.equal(typeof localMeters, "number", `${point.name} is outside bundled JPGEO2024`);
  const differenceMeters = localMeters - point.legacyCgiMeters;
  assert.ok(Math.abs(differenceMeters) <= 0.000_051, `${point.name} exceeds the 0.0051 cm gate`);
  return {
    ...point,
    localMeters,
    differenceMeters,
    absoluteDifferenceCentimeters: Math.abs(differenceMeters) * 100,
  };
});

const outputPath = path.resolve(process.argv[2] ?? "evidence/gsi-local-five-site-audit-20260926.json");
const report = {
  generatedAt: new Date().toISOString(),
  model: "JPGEO2024",
  interpolation: "bilinear on the original 1 arc-minute x 1.5 arc-minute grid",
  toleranceMeters: 0.000_051,
  maximumAbsoluteDifferenceMeters: Math.max(...points.map((point) => Math.abs(point.differenceMeters))),
  points,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
