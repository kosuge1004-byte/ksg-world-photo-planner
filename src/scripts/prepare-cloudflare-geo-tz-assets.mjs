import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PART_BYTES = 4 * 1024 * 1024;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const geoTzEntry = fileURLToPath(import.meta.resolve("geo-tz"));
const geoTzRoot = path.resolve(path.dirname(geoTzEntry), "..");
const sourceDirectory = path.join(geoTzRoot, "data");
const outputDirectory = path.join(
  projectRoot,
  "public",
  "__astro_internal_geo_tz"
);
const indexSource = path.join(sourceDirectory, "timezones-1970.geojson.index.json");
const dataSource = path.join(sourceDirectory, "timezones-1970.geojson.geo.dat");

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(
  indexSource,
  path.join(outputDirectory, "timezones-1970.index.json")
);

const data = fs.readFileSync(dataSource);
let partCount = 0;
for (let offset = 0; offset < data.length; offset += DATA_PART_BYTES) {
  const partName = `timezones-1970.part-${partCount.toString().padStart(3, "0")}.bin`;
  fs.writeFileSync(
    path.join(outputDirectory, partName),
    data.subarray(offset, Math.min(data.length, offset + DATA_PART_BYTES))
  );
  partCount += 1;
}

console.log(JSON.stringify({
  geoTzAssets: outputDirectory,
  dataBytes: data.length,
  partCount,
}));
