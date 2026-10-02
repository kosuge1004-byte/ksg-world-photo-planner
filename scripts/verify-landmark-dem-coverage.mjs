import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootUrl = new URL("../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, rootUrl), "utf8");
const rowPattern = /\{\s*name:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*latitude:\s*(-?\d+(?:\.\d+)?),\s*longitude:\s*(-?\d+(?:\.\d+)?)/g;
const landmarks = [...read("src/data/japanLandmarks.ts").matchAll(rowPattern)].map((match) => match[1]);

const seedCount = [...read("server/landmarkPrewarmSeed.ts").matchAll(rowPattern)].length;
assert.ok(landmarks.length >= 288, "the authoritative spot-search catalogue must parse completely");
assert.equal(landmarks.length, seedCount, "client catalogue and server seed must list the same landmarks");
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

const fuji100 = JSON.parse(read("dem/gsi-landmark-dem-fuji-100km-manifest.json"));
assert.equal(fuji100.landmarkSource, "src/data/japanLandmarks.ts");
assert.equal(fuji100.landmarkCount, 1);
assert.equal(fuji100.radiusMeters, 100_000);
const fujiOwners = new Set(Object.values(fuji100.landmarksByMesh).flat());
assert.deepEqual([...fujiOwners], ["富士山"]);
assert.ok(fuji100.meshCount > 0, "Fuji 100km manifest must contain meshes");

console.log(`landmark DEM coverage verification passed (${landmarks.length}/${landmarks.length})`);
