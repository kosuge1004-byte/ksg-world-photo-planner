import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootUrl = new URL("../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, rootUrl), "utf8");
const rowPattern = /\{\s*name:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*latitude:\s*(-?\d+(?:\.\d+)?),\s*longitude:\s*(-?\d+(?:\.\d+)?)/g;
const landmarks = [...read("src/data/japanLandmarks.ts").matchAll(rowPattern)].map((match) => match[1]);

assert.equal(landmarks.length, 284, "the authoritative spot-search catalogue must parse completely");
assert.equal(new Set(landmarks).size, landmarks.length, "landmark names must be unique for manifest ownership");

for (const suffix of ["center", "3km", "10km", "50km"]) {
  const manifest = JSON.parse(read(`dem/gsi-landmark-dem-${suffix}-manifest.json`));
  assert.equal(manifest.landmarkSource, "src/data/japanLandmarks.ts");
  assert.equal(manifest.landmarkCount, landmarks.length);
  const covered = new Set(Object.values(manifest.landmarksByMesh).flat());
  for (const name of landmarks) {
    assert.ok(covered.has(name), `${suffix} manifest is missing ${name}`);
  }
}

console.log("landmark DEM coverage verification passed (284/284)");
