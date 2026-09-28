import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { ACTIVE_PREWARM_LANDMARKS } from "../server/landmarkPrewarmSeed.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_DIRECTORY,
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  isPrecomputedBearingProfileResponse,
  precomputedBearingProfileIdentity,
} from "../server/precomputedBearingProfiles.ts";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const dataRoot = path.resolve(
  process.env.LOCAL_DEM_DATA_ROOT || "E:\\AstroSight-GSI-data-20260926\\dem\\r2-ready"
);
const profileRoot = path.join(dataRoot, PRECOMPUTED_BEARING_PROFILE_DIRECTORY);
const outputArgumentIndex = process.argv.indexOf("--output");
const outputPath = path.resolve(
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1]
    ? process.argv[outputArgumentIndex + 1]
    : path.join(repositoryRoot, "evidence", "precomputed-landmark-profile-audit.json")
);
const bearings = Array.from({ length: 360 }, (_, index) => index);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifestBytes = await readFile(path.join(profileRoot, "manifest.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
assert(manifest?.schemaVersion === 1, "manifest schemaVersion is invalid");
assert(manifest?.format === PRECOMPUTED_BEARING_PROFILE_FORMAT, "manifest format is invalid");
assert(manifest?.entries && typeof manifest.entries === "object", "manifest entries are invalid");

const expected = new Map();
const expectedNames = new Set();
for (const landmark of ACTIVE_PREWARM_LANDMARKS) {
  const identity = precomputedBearingProfileIdentity({
    latitude: landmark.latitude,
    longitude: landmark.longitude,
    maxDistanceMeters: 10_000,
  });
  assert(!expected.has(identity), `duplicate catalogue identity: ${identity}`);
  assert(!expectedNames.has(landmark.name), `duplicate catalogue name: ${landmark.name}`);
  expected.set(identity, landmark);
  expectedNames.add(landmark.name);
}

const entries = Object.entries(manifest.entries);
assert(entries.length === expected.size, `manifest has ${entries.length} entries; expected ${expected.size}`);
const files = (await readdir(profileRoot)).filter((name) => name.endsWith(".json.gz"));
assert(files.length === expected.size, `profile directory has ${files.length} gzip files; expected ${expected.size}`);

const seenFiles = new Set();
const seenNames = new Set();
let compressedBytes = 0;
let uncompressedBytes = 0;
let pointCount = 0;
let minimumBytes = Number.POSITIVE_INFINITY;
let maximumBytes = 0;

for (const [identity, entry] of entries) {
  const landmark = expected.get(identity);
  assert(landmark, `unexpected manifest identity: ${identity}`);
  assert(entry.name === landmark.name, `name mismatch for ${identity}`);
  assert(entry.latitude === landmark.latitude, `latitude mismatch for ${entry.name}`);
  assert(entry.longitude === landmark.longitude, `longitude mismatch for ${entry.name}`);
  assert(entry.maxDistanceMeters === 10_000, `distance mismatch for ${entry.name}`);
  assert(/^[a-f0-9]{64}\.json\.gz$/.test(entry.file), `unsafe filename for ${entry.name}`);
  assert(!seenFiles.has(entry.file), `duplicate profile filename: ${entry.file}`);
  assert(!seenNames.has(entry.name), `duplicate manifest name: ${entry.name}`);
  seenFiles.add(entry.file);
  seenNames.add(entry.name);

  const filePath = path.join(profileRoot, entry.file);
  const metadata = await stat(filePath);
  assert(metadata.isFile(), `profile is not a regular file: ${entry.name}`);
  assert(metadata.size === entry.bytes, `compressed size mismatch for ${entry.name}`);
  const compressed = await readFile(filePath);
  assert(sha256(compressed) === entry.sha256, `SHA-256 mismatch for ${entry.name}`);
  const raw = gunzipSync(compressed, { maxOutputLength: 32 * 1_048_576 });
  const payload = JSON.parse(raw.toString("utf8"));
  assert(payload?.schemaVersion === 1, `payload schema mismatch for ${entry.name}`);
  assert(payload?.format === PRECOMPUTED_BEARING_PROFILE_FORMAT, `payload format mismatch for ${entry.name}`);
  assert(payload?.subject?.name === entry.name, `payload name mismatch for ${entry.name}`);
  assert(payload?.subject?.latitude === entry.latitude, `payload latitude mismatch for ${entry.name}`);
  assert(payload?.subject?.longitude === entry.longitude, `payload longitude mismatch for ${entry.name}`);
  assert(payload?.maxDistanceMeters === entry.maxDistanceMeters, `payload distance mismatch for ${entry.name}`);
  assert(
    isPrecomputedBearingProfileResponse(payload.response, {
      bearings,
      maxDistanceMeters: entry.maxDistanceMeters,
    }),
    `profile response is incomplete or invalid for ${entry.name}`
  );
  assert(entry.profileCount === 360, `profile count mismatch for ${entry.name}`);
  assert(entry.profileCount === payload.response.profiles.length, `manifest profile count mismatch for ${entry.name}`);
  assert(entry.pointCount === payload.response.pointCount, `manifest point count mismatch for ${entry.name}`);

  compressedBytes += compressed.length;
  uncompressedBytes += raw.length;
  pointCount += payload.response.pointCount;
  minimumBytes = Math.min(minimumBytes, compressed.length);
  maximumBytes = Math.max(maximumBytes, compressed.length);
}

for (const file of files) assert(seenFiles.has(file), `orphan profile file: ${file}`);
for (const landmark of ACTIVE_PREWARM_LANDMARKS) assert(seenNames.has(landmark.name), `missing profile: ${landmark.name}`);

const report = {
  generatedAt: new Date().toISOString(),
  format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
  dataRoot,
  profileRoot,
  status: "PASS",
  expectedLandmarkCount: expected.size,
  manifestEntryCount: entries.length,
  profileFileCount: files.length,
  bearingsPerLandmark: 360,
  maximumDistanceMeters: 10_000,
  totalTerrainPointCount: pointCount,
  compressedBytes,
  uncompressedBytes,
  minimumCompressedFileBytes: minimumBytes,
  maximumCompressedFileBytes: maximumBytes,
  manifestSha256: sha256(manifestBytes),
  checks: {
    exactCatalogueMatch: true,
    everyChecksumMatches: true,
    everyGzipReadable: true,
    everyProfileHasAllBearings: true,
    everyProfileResponseValid: true,
    noOrphanFiles: true,
  },
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
console.log(`report: ${outputPath}`);
