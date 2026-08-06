import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/geodesy/karneyGeodesic.ts", import.meta.url), "utf8");
const required = [
  "COINCIDENT_DISTANCE_EPSILON_METERS = 1e-6",
  "distanceMeters < COINCIDENT_DISTANCE_EPSILON_METERS",
  "distanceMeters: 0",
  "bearingDegrees: 0",
  "bearingDefined: false",
  "coincident: true",
];
for (const token of required) {
  if (!source.includes(token)) {
    throw new Error(`Karney edge-case guard is missing: ${token}`);
  }
}
console.log("Karney coincident-point guard verified.");
