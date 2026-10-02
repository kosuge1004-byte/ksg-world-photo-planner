import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { computeBearingProfileBatch } from "../server/bearingProfileBatch.ts";
import { ACTIVE_PREWARM_LANDMARKS } from "../server/landmarkPrewarmSeed.ts";
import {
  findPrecomputedBearingProfileTarget,
  REGISTERED_PROFILE_DEFAULT_DISTANCE_METERS,
} from "../src/data/precomputedBearingProfileTargets.ts";
import { configureLocalDemMemoryBudgetForPrivateOrigin } from "../server/gsiLocalDem.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_DIRECTORY,
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  isPrecomputedBearingProfileResponse,
  precomputedBearingProfileIdentity,
} from "../server/precomputedBearingProfiles.ts";
import { createReadOnlyDemCache } from "../tools/local-dem-server/readOnlyDemCache.ts";

const gzipAsync = promisify(gzip);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function integerOption(name, fallback, minimum, maximum) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(filePath, bytes) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: "w" });
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

const dataRoot = path.resolve(option(
  "data-root",
  process.env.LOCAL_DEM_DATA_ROOT || "E:\\AstroSight-GSI-data-20260926\\dem\\r2-ready"
));
const outputRoot = path.resolve(
  option("output", path.join(dataRoot, PRECOMPUTED_BEARING_PROFILE_DIRECTORY))
);
const hasDistanceOverride = process.argv.slice(2).some((value) => value.startsWith("--distance="));
const distanceOverrideMeters = hasDistanceOverride
  ? integerOption("distance", REGISTERED_PROFILE_DEFAULT_DISTANCE_METERS, 8, 100_000)
  : null;
const start = integerOption("start", 0, 0, ACTIVE_PREWARM_LANDMARKS.length);
const count = integerOption(
  "count",
  ACTIVE_PREWARM_LANDMARKS.length - start,
  0,
  ACTIVE_PREWARM_LANDMARKS.length - start
);
const force = process.argv.includes("--force");
const prune = process.argv.includes("--prune");
const noManifest = process.argv.includes("--no-manifest");
const rebuildManifest = process.argv.includes("--rebuild-manifest");
const memoryMiB = integerOption("memory-mib", 1024, 32, 2048);
const bearings = Array.from({ length: 360 }, (_, index) => index);

await mkdir(outputRoot, { recursive: true });
const manifestPath = path.join(outputRoot, "manifest.json");
let entries = {};
try {
  const existing = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    existing?.schemaVersion === 1 &&
    existing?.format === PRECOMPUTED_BEARING_PROFILE_FORMAT &&
    existing?.entries && typeof existing.entries === "object"
  ) entries = existing.entries;
} catch {
  // A first run has no manifest. Invalid/incomplete files are replaced below.
}

const persistentCache = await createReadOnlyDemCache(dataRoot);
await persistentCache.validateReady();
configureLocalDemMemoryBudgetForPrivateOrigin(memoryMiB * 1024 * 1024);
configureServerRuntime({ persistentCache });

if (rebuildManifest) {
  const rebuiltEntries = {};
  for (const file of (await readdir(outputRoot)).filter((name) => /^[a-f0-9]{64}\.json\.gz$/.test(name))) {
    try {
      const filePath = path.join(outputRoot, file);
      const compressed = await readFile(filePath);
      const payload = JSON.parse(gunzipSync(compressed, { maxOutputLength: 64 * 1_048_576 }).toString("utf8"));
      const request = {
        bearings: payload?.response?.profiles?.map((profile) => profile.bearingDegrees) ?? [],
        maxDistanceMeters: payload?.maxDistanceMeters,
      };
      if (
        payload?.schemaVersion !== 1 ||
        payload?.format !== PRECOMPUTED_BEARING_PROFILE_FORMAT ||
        typeof payload?.subject?.name !== "string" ||
        !Number.isFinite(payload?.subject?.latitude) ||
        !Number.isFinite(payload?.subject?.longitude) ||
        !isPrecomputedBearingProfileResponse(payload.response, request)
      ) continue;
      const identity = precomputedBearingProfileIdentity({
        latitude: payload.subject.latitude,
        longitude: payload.subject.longitude,
        maxDistanceMeters: payload.maxDistanceMeters,
      });
      if (file !== `${sha256(identity)}.json.gz`) continue;
      const metadata = await stat(filePath);
      rebuiltEntries[identity] = {
        name: payload.subject.name,
        latitude: payload.subject.latitude,
        longitude: payload.subject.longitude,
        maxDistanceMeters: payload.maxDistanceMeters,
        file,
        bytes: metadata.size,
        sha256: sha256(compressed),
        profileCount: payload.response.profiles.length,
        pointCount: payload.response.pointCount,
      };
    } catch {
      // A truncated worker output is excluded rather than published.
    }
  }
  entries = rebuiltEntries;
  const manifest = {
    schemaVersion: 1,
    format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))),
  };
  await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  console.log(JSON.stringify({ rebuilt: Object.keys(entries).length, manifest: manifestPath }));
  process.exit(0);
}

const selected = ACTIVE_PREWARM_LANDMARKS.slice(start, start + count);
if (prune && (start !== 0 || count !== ACTIVE_PREWARM_LANDMARKS.length || distanceOverrideMeters !== null)) {
  throw new Error("--prune requires the complete registered-target run without --distance");
}
const report = {
  generatedAt: new Date().toISOString(),
  dataRoot,
  outputRoot,
  distanceMode: distanceOverrideMeters === null ? "registered-target" : "override",
  maxDistanceMeters: distanceOverrideMeters,
  requested: selected.length,
  generated: 0,
  skipped: 0,
  failed: [],
  elapsedMs: 0,
};
const startedAt = Date.now();

async function saveManifest() {
  if (noManifest) return;
  const manifest = {
    schemaVersion: 1,
    format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))),
  };
  await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
}

for (const [offset, landmark] of selected.entries()) {
  const target = findPrecomputedBearingProfileTarget(landmark.latitude, landmark.longitude);
  const maxDistanceMeters = distanceOverrideMeters ??
    target?.maxDistanceMeters ??
    REGISTERED_PROFILE_DEFAULT_DISTANCE_METERS;
  const identity = precomputedBearingProfileIdentity({
    latitude: landmark.latitude,
    longitude: landmark.longitude,
    maxDistanceMeters,
  });
  const fileName = `${sha256(identity)}.json.gz`;
  const filePath = path.join(outputRoot, fileName);
  if (
    !force &&
    entries[identity]?.file === fileName &&
    entries[identity]?.name === landmark.name &&
    entries[identity]?.latitude === landmark.latitude &&
    entries[identity]?.longitude === landmark.longitude &&
    entries[identity]?.maxDistanceMeters === maxDistanceMeters
  ) {
    try {
      const existing = await readFile(filePath);
      if (existing.length === entries[identity].bytes && sha256(existing) === entries[identity].sha256) {
        report.skipped += 1;
        console.log(`[${offset + 1}/${selected.length}] ${landmark.name}: already complete`);
        continue;
      }
    } catch {
      // Regenerate a missing or damaged entry.
    }
  }

  const itemStartedAt = Date.now();
  console.log(`[${offset + 1}/${selected.length}] ${landmark.name}: calculating 360 bearings`);
  try {
    const request = {
      subjectPoint: {
        latitude: landmark.latitude,
        longitude: landmark.longitude,
        height: landmark.heightMeters ?? 0,
        label: landmark.name,
      },
      cameraSettings: { lensCenterHeightMeters: 1.6 },
      bearings,
      maxDistanceMeters,
    };
    const response = await computeBearingProfileBatch(request);
    if (!isPrecomputedBearingProfileResponse(response, request)) {
      const reason = response.failedBearings[0]?.reason || "incomplete profile response";
      throw new Error(reason);
    }
    const generatedAt = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
      subject: {
        name: landmark.name,
        latitude: landmark.latitude,
        longitude: landmark.longitude,
      },
      maxDistanceMeters,
      generatedAt,
      response,
    };
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"), {
      level: 9,
      mtime: 0,
    });
    await atomicWrite(filePath, compressed);
    entries[identity] = {
      name: landmark.name,
      latitude: landmark.latitude,
      longitude: landmark.longitude,
      maxDistanceMeters,
      file: fileName,
      bytes: compressed.length,
      sha256: sha256(compressed),
      profileCount: response.profiles.length,
      pointCount: response.pointCount,
    };
    await saveManifest();
    report.generated += 1;
    console.log(`  complete: ${(compressed.length / 1_048_576).toFixed(2)} MiB, ${((Date.now() - itemStartedAt) / 1000).toFixed(1)} s`);
  } catch (error) {
    report.failed.push({
      name: landmark.name,
      reason: error instanceof Error ? error.message : String(error),
    });
    console.error(`  failed: ${report.failed.at(-1).reason}`);
  }
}

if (prune) {
  const expectedIdentities = new Set(ACTIVE_PREWARM_LANDMARKS.map((landmark) => {
    const target = findPrecomputedBearingProfileTarget(landmark.latitude, landmark.longitude);
    return precomputedBearingProfileIdentity({
      latitude: landmark.latitude,
      longitude: landmark.longitude,
      maxDistanceMeters: target?.maxDistanceMeters ?? REGISTERED_PROFILE_DEFAULT_DISTANCE_METERS,
    });
  }));
  for (const [identity, entry] of Object.entries(entries)) {
    if (expectedIdentities.has(identity)) continue;
    if (/^[a-f0-9]{64}\.json\.gz$/u.test(entry.file)) {
      await rm(path.join(outputRoot, entry.file), { force: true });
    }
    delete entries[identity];
  }
}
await saveManifest();
report.elapsedMs = Date.now() - startedAt;
const reportPath = path.join(repositoryRoot, "evidence", "precomputed-landmark-profiles-latest.json");
const effectiveReportPath = noManifest
  ? path.join(repositoryRoot, "evidence", `precomputed-landmark-profiles-${start}-${count}.json`)
  : reportPath;
await mkdir(path.dirname(reportPath), { recursive: true });
await atomicWrite(effectiveReportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
console.log(JSON.stringify({
  generated: report.generated,
  skipped: report.skipped,
  failed: report.failed.length,
  elapsedSeconds: Number((report.elapsedMs / 1000).toFixed(1)),
  manifest: manifestPath,
  report: effectiveReportPath,
}));
if (report.failed.length > 0) process.exitCode = 1;
