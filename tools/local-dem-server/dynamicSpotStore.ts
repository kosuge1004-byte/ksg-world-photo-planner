import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DYNAMIC_SPOT_BEARING_COUNT,
  DYNAMIC_SPOT_MAX_DISTANCE_METERS,
  DYNAMIC_SPOT_PROFILE_VERSION,
  DYNAMIC_SPOT_SCHEMA_VERSION,
  dynamicSpotCoordinateKey,
  isDynamicSpotRecord,
  normalizeDynamicSpotSearchText,
  type DynamicSpotRecord,
  type DynamicSpotRegistrationInput,
} from "../../src/types/dynamicSpot.ts";
import type {
  BearingProfileBatchCompactProfile,
  BearingProfileBatchRequest,
  BearingProfileBatchResponseV2,
} from "../../src/types/bearingProfileBatch.ts";
import {
  isPrecomputedBearingProfileResponse,
  selectPrecomputedBearingProfiles,
} from "../../server/precomputedBearingProfiles.ts";

const STORE_DIRECTORY = "dynamic-spots-v1";
const MANIFEST_FORMAT = "astrosight-dynamic-spots-v1";
const MAX_MANIFEST_BYTES = 16 * 1_048_576;
const MAX_COMPLETE_PROFILE_BYTES = 32 * 1_048_576;
const BEARINGS_PER_COMPUTE = 24;

type DynamicSpotManifest = {
  schemaVersion: 1;
  format: typeof MANIFEST_FORMAT;
  updatedAt: string;
  records: Record<string, DynamicSpotRecord>;
};

type StoredBearing = {
  schemaVersion: 1;
  coordinateKey: string;
  maxDistanceMeters: number;
  distancesMeters: number[];
  profile: BearingProfileBatchCompactProfile;
};

type CompleteDynamicProfile = {
  schemaVersion: 1;
  format: "astrosight-dynamic-spot-profile-v1";
  dynamicSpot: DynamicSpotRecord;
  response: BearingProfileBatchResponseV2;
};

export type DynamicSpotProfileCompute = (
  request: BearingProfileBatchRequest,
  signal: AbortSignal
) => Promise<BearingProfileBatchResponseV2>;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function generatedId(coordinateKey: string): string {
  return `dynamic-${sha256(coordinateKey).slice(0, 32)}`;
}

function dynamicRootFromDataRoot(dataRoot: string): string {
  // The installed layout uses <root>/dem/r2-ready. Keep dynamic records out of
  // the immutable prepared data when that layout is detected. Test/custom
  // layouts remain safely contained under their configured root.
  if (path.basename(dataRoot).toLocaleLowerCase() === "r2-ready" &&
    path.basename(path.dirname(dataRoot)).toLocaleLowerCase() === "dem") {
    return path.resolve(dataRoot, "..", "..", STORE_DIRECTORY);
  }
  return path.resolve(dataRoot, STORE_DIRECTORY);
}

function validManifest(value: unknown): value is DynamicSpotManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const manifest = value as Partial<DynamicSpotManifest>;
  if (manifest.schemaVersion !== 1 || manifest.format !== MANIFEST_FORMAT ||
    typeof manifest.updatedAt !== "string" ||
    typeof manifest.records !== "object" || manifest.records === null) return false;
  return Object.entries(manifest.records).every(([coordinateKey, record]) =>
    isDynamicSpotRecord(record) && record.coordinateKey === coordinateKey
  );
}

function validStoredBearing(value: unknown, record: DynamicSpotRecord, bearing: number): value is StoredBearing {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stored = value as Partial<StoredBearing>;
  return stored.schemaVersion === 1 && stored.coordinateKey === record.coordinateKey &&
    stored.maxDistanceMeters === DYNAMIC_SPOT_MAX_DISTANCE_METERS &&
    Array.isArray(stored.distancesMeters) && stored.distancesMeters.length > 0 &&
    stored.distancesMeters.every((distance, index) => Number.isFinite(distance) && distance >= 0 &&
      (index === 0 || distance > (stored.distancesMeters?.[index - 1] ?? Number.POSITIVE_INFINITY))) &&
    stored.distancesMeters.at(-1) === DYNAMIC_SPOT_MAX_DISTANCE_METERS &&
    typeof stored.profile === "object" && stored.profile !== null &&
    stored.profile.bearingDegrees === bearing &&
    Array.isArray(stored.profile.ellipsoidalHeightsMeters) &&
    stored.profile.ellipsoidalHeightsMeters.length === stored.distancesMeters.length &&
    stored.profile.ellipsoidalHeightsMeters.every(Number.isFinite) &&
    Array.isArray(stored.profile.elevationSources) &&
    stored.profile.elevationSources.length === stored.distancesMeters.length;
}

function heightReady(record: DynamicSpotRecord): boolean {
  return record.subjectSurface === "terrain" ||
    (record.structureHeightMeters !== null && record.heightSourceType !== "unknown" &&
      record.heightStatus !== "unknown");
}

function heightQuality(record: Pick<DynamicSpotRecord, "heightStatus">): number {
  return record.heightStatus === "verified" ? 4 : record.heightStatus === "measured" ? 3 :
    record.heightStatus === "estimated" ? 2 : 1;
}

async function atomicWrite(
  filePath: string,
  bytes: Buffer,
  validate: (bytes: Buffer) => void
): Promise<void> {
  validate(bytes);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Node's rename uses replacement semantics on the supported Windows host;
  // the destination is therefore never observed as a partially written file.
  await rename(temporary, filePath);
}

export type DynamicSpotStore = {
  root: string;
  register(input: DynamicSpotRegistrationInput): Promise<DynamicSpotRecord>;
  lookupByQuery(query: string): DynamicSpotRecord | null;
  lookupByCoordinate(latitude: number, longitude: number): DynamicSpotRecord | null;
  retry(latitude: number, longitude: number): Promise<DynamicSpotRecord | null>;
  lookupProfile(request: BearingProfileBatchRequest): Promise<BearingProfileBatchResponseV2 | null>;
  resumeIncomplete(): void;
};

export async function createDynamicSpotStore(
  configuredDataRoot: string,
  compute: DynamicSpotProfileCompute
): Promise<DynamicSpotStore> {
  const canonicalDataRoot = await realpath(path.resolve(configuredDataRoot));
  const requestedRoot = dynamicRootFromDataRoot(canonicalDataRoot);
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const allowedParent = path.basename(canonicalDataRoot).toLocaleLowerCase() === "r2-ready" &&
    path.basename(path.dirname(canonicalDataRoot)).toLocaleLowerCase() === "dem"
    ? path.resolve(canonicalDataRoot, "..", "..")
    : canonicalDataRoot;
  if (!isInside(allowedParent, root)) throw new Error("invalid dynamic spot root");
  const manifestPath = path.resolve(root, "manifest.json");
  const spotsRoot = path.resolve(root, "spots");
  const profilesRoot = path.resolve(root, "profiles");
  for (const candidate of [manifestPath, spotsRoot, profilesRoot]) {
    if (!isInside(root, candidate)) throw new Error("invalid dynamic spot store path");
  }
  await mkdir(spotsRoot, { recursive: true });
  await mkdir(profilesRoot, { recursive: true });

  let records: Record<string, DynamicSpotRecord> = {};
  try {
    const metadata = await stat(manifestPath);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_MANIFEST_BYTES) {
      throw new Error("dynamic spot manifest is invalid");
    }
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!validManifest(parsed)) throw new Error("dynamic spot manifest is invalid");
    records = parsed.records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let persistenceQueue = Promise.resolve();
  const persistRecord = async (record: DynamicSpotRecord): Promise<void> => {
    if (!isDynamicSpotRecord(record)) throw new Error("dynamic spot record is invalid");
    records = { ...records, [record.coordinateKey]: record };
    persistenceQueue = persistenceQueue.then(async () => {
      const spotBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await atomicWrite(path.join(spotsRoot, `${record.id}.json`), spotBytes, (bytes) => {
        const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        if (!isDynamicSpotRecord(parsed)) throw new Error("dynamic spot record verification failed");
      });
      const manifest: DynamicSpotManifest = {
        schemaVersion: 1,
        format: MANIFEST_FORMAT,
        updatedAt: new Date().toISOString(),
        records: Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right))),
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await atomicWrite(manifestPath, manifestBytes, (bytes) => {
        if (!validManifest(JSON.parse(bytes.toString("utf8")) as unknown)) {
          throw new Error("dynamic spot manifest verification failed");
        }
      });
    });
    await persistenceQueue;
  };

  const profileDirectory = (record: DynamicSpotRecord): string => {
    const candidate = path.resolve(profilesRoot, record.id);
    if (!isInside(profilesRoot, candidate)) throw new Error("invalid dynamic profile path");
    return candidate;
  };
  const bearingPath = (record: DynamicSpotRecord, bearing: number): string => {
    if (!Number.isInteger(bearing) || bearing < 0 || bearing >= DYNAMIC_SPOT_BEARING_COUNT) {
      throw new Error("invalid dynamic profile bearing");
    }
    return path.join(profileDirectory(record), "bearings", `${bearing.toString().padStart(3, "0")}.json`);
  };

  const readBearing = async (record: DynamicSpotRecord, bearing: number): Promise<StoredBearing | null> => {
    try {
      const value = JSON.parse(await readFile(bearingPath(record, bearing), "utf8")) as unknown;
      return validStoredBearing(value, record, bearing) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  };

  const writeBearing = async (
    record: DynamicSpotRecord,
    distancesMeters: number[],
    profile: BearingProfileBatchCompactProfile
  ): Promise<void> => {
    const value: StoredBearing = {
      schemaVersion: 1,
      coordinateKey: record.coordinateKey,
      maxDistanceMeters: DYNAMIC_SPOT_MAX_DISTANCE_METERS,
      distancesMeters,
      profile,
    };
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    await atomicWrite(bearingPath(record, profile.bearingDegrees), bytes, (candidate) => {
      const parsed = JSON.parse(candidate.toString("utf8")) as unknown;
      if (!validStoredBearing(parsed, record, profile.bearingDegrees)) {
        throw new Error("dynamic bearing verification failed");
      }
    });
  };

  let jobQueue = Promise.resolve();
  const queued = new Set<string>();

  const runGeneration = async (coordinateKey: string): Promise<void> => {
    let record = records[coordinateKey];
    if (!record || record.demProfileStatus === "complete" || !heightReady(record)) return;
    const started = Date.now();
    const generationStartedAt = record.generationStartedAt ?? new Date().toISOString();
    const existing = new Map<number, StoredBearing>();
    for (let bearing = 0; bearing < DYNAMIC_SPOT_BEARING_COUNT; bearing += 1) {
      const stored = await readBearing(record, bearing);
      if (stored) existing.set(bearing, stored);
    }
    record = {
      ...record,
      demProfileStatus: existing.size > 0 ? "partial" : "pending",
      completedBearings: existing.size,
      failedBearings: 0,
      currentStage: "terrain",
      generationStartedAt,
      generationElapsedMs: Math.max(0, Date.now() - Date.parse(generationStartedAt)),
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    await persistRecord(record);

    const missing = Array.from({ length: DYNAMIC_SPOT_BEARING_COUNT }, (_, bearing) => bearing)
      .filter((bearing) => !existing.has(bearing));
    const failures: string[] = [];
    for (let offset = 0; offset < missing.length; offset += BEARINGS_PER_COMPUTE) {
      const bearings = missing.slice(offset, offset + BEARINGS_PER_COMPUTE);
      const controller = new AbortController();
      try {
        const response = await compute({
          subjectPoint: {
            latitude: record.latitude,
            longitude: record.longitude,
            height: record.structureHeightMeters ?? 0,
            label: record.name,
            subjectSurfaceTarget: record.subjectSurface === "structure" ? "structure-roof" : "terrain",
            structureHeightMeters: record.subjectSurface === "structure"
              ? record.structureHeightMeters ?? undefined
              : undefined,
          },
          cameraSettings: { lensCenterHeightMeters: 1.6 },
          bearings,
          maxDistanceMeters: DYNAMIC_SPOT_MAX_DISTANCE_METERS,
        }, controller.signal);
        const acceptedProfiles = response.profiles.filter((profile) =>
          bearings.includes(profile.bearingDegrees)
        );
        await Promise.all(acceptedProfiles.map((profile) =>
          writeBearing(record, response.distancesMeters, profile)
        ));
        for (const profile of acceptedProfiles) {
          existing.set(profile.bearingDegrees, {
            schemaVersion: 1,
            coordinateKey,
            maxDistanceMeters: DYNAMIC_SPOT_MAX_DISTANCE_METERS,
            distancesMeters: response.distancesMeters,
            profile,
          });
        }
        for (const failure of response.failedBearings) failures.push(`${failure.bearingDegrees}°: ${failure.reason}`);
      } catch (error) {
        failures.push(`${bearings[0]}-${bearings.at(-1)}°: ${error instanceof Error ? error.message : String(error)}`);
      }
      record = {
        ...record,
        demProfileStatus: existing.size > 0 ? "partial" : "pending",
        completedBearings: existing.size,
        failedBearings: failures.length,
        currentStage: "terrain",
        generationElapsedMs: Math.max(0, Date.now() - Date.parse(generationStartedAt)),
        lastError: failures.at(-1) ?? null,
        updatedAt: new Date().toISOString(),
      };
      await persistRecord(record);
    }

    if (existing.size !== DYNAMIC_SPOT_BEARING_COUNT) {
      await persistRecord({
        ...record,
        demProfileStatus: existing.size > 0 ? "partial" : "failed",
        completedBearings: existing.size,
        failedBearings: DYNAMIC_SPOT_BEARING_COUNT - existing.size,
        currentStage: "failed",
        generationElapsedMs: Date.now() - started + (record.generationElapsedMs ?? 0),
        lastError: failures.at(-1) ?? "一部方位の地形データを生成できませんでした",
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    record = { ...record, currentStage: "validating", updatedAt: new Date().toISOString() };
    await persistRecord(record);
    const first = existing.get(0);
    if (!first) throw new Error("dynamic profile bearing 0 is missing");
    if (Array.from(existing.values()).some((entry) =>
      entry.distancesMeters.length !== first.distancesMeters.length ||
      entry.distancesMeters.some((distance, index) => distance !== first.distancesMeters[index])
    )) {
      throw new Error("dynamic profile distance sampling mismatch");
    }
    const response: BearingProfileBatchResponseV2 = {
      version: 2,
      precomputed: true,
      terrainProfileComplete: true,
      distancesMeters: first.distancesMeters,
      profiles: Array.from(existing.values())
        .sort((left, right) => left.profile.bearingDegrees - right.profile.bearingDegrees)
        .map((entry) => entry.profile),
      failedBearings: [],
      requestedBearingCount: DYNAMIC_SPOT_BEARING_COUNT,
      pointCount: DYNAMIC_SPOT_BEARING_COUNT * first.distancesMeters.length,
    };
    const completeRequest: BearingProfileBatchRequest = {
      subjectPoint: { latitude: record.latitude, longitude: record.longitude, height: 0, label: record.name },
      cameraSettings: { lensCenterHeightMeters: 1.6 },
      bearings: Array.from({ length: DYNAMIC_SPOT_BEARING_COUNT }, (_, bearing) => bearing),
      maxDistanceMeters: DYNAMIC_SPOT_MAX_DISTANCE_METERS,
    };
    if (!isPrecomputedBearingProfileResponse(response, completeRequest)) {
      throw new Error("dynamic profile completeness verification failed");
    }

    const completedAt = new Date().toISOString();
    const finalRecord: DynamicSpotRecord = {
      ...record,
      demProfileStatus: "complete",
      completedBearings: DYNAMIC_SPOT_BEARING_COUNT,
      failedBearings: 0,
      currentStage: "complete",
      generationElapsedMs: Math.max(0, Date.now() - Date.parse(generationStartedAt)),
      lastError: null,
      updatedAt: completedAt,
      profileBytes: 1,
      profileSha256: "0".repeat(64),
    };
    const payload: CompleteDynamicProfile = {
      schemaVersion: 1,
      format: "astrosight-dynamic-spot-profile-v1",
      dynamicSpot: finalRecord,
      response,
    };
    let compressed = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9, mtime: 0 });
    const checksum = sha256(compressed);
    finalRecord.profileBytes = compressed.length;
    finalRecord.profileSha256 = checksum;
    payload.dynamicSpot = finalRecord;
    // The embedded complete record includes the digest of the file. Avoid a
    // self-referential checksum by storing the digest in the authoritative
    // manifest record and validating the embedded record except for these two
    // fields when reading.
    compressed = gzipSync(Buffer.from(JSON.stringify({ ...payload, dynamicSpot: {
      ...finalRecord, profileBytes: 0, profileSha256: null,
    } }), "utf8"), { level: 9, mtime: 0 });
    finalRecord.profileBytes = compressed.length;
    finalRecord.profileSha256 = sha256(compressed);
    const completePath = path.join(profileDirectory(finalRecord), "complete.json.gz");
    await atomicWrite(completePath, compressed, (bytes) => {
      if (bytes.length < 1 || bytes.length > MAX_COMPLETE_PROFILE_BYTES) throw new Error("dynamic profile file is too large");
      const parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1_048_576 }).toString("utf8")) as CompleteDynamicProfile;
      if (parsed.format !== "astrosight-dynamic-spot-profile-v1" ||
        !isPrecomputedBearingProfileResponse(parsed.response, completeRequest)) {
        throw new Error("dynamic profile file verification failed");
      }
    });
    const reread = await readFile(completePath);
    if (sha256(reread) !== finalRecord.profileSha256 || reread.length !== finalRecord.profileBytes) {
      throw new Error("dynamic profile checksum verification failed");
    }
    await persistRecord(finalRecord);
  };

  const enqueue = (coordinateKey: string): void => {
    if (queued.has(coordinateKey)) return;
    queued.add(coordinateKey);
    jobQueue = jobQueue.then(() => runGeneration(coordinateKey))
      .catch(async (error) => {
        const current = records[coordinateKey];
        if (!current || current.demProfileStatus === "complete") return;
        await persistRecord({
          ...current,
          demProfileStatus: (current.completedBearings ?? 0) > 0 ? "partial" : "failed",
          currentStage: "failed",
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
      })
      .finally(() => queued.delete(coordinateKey));
  };

  const lookupByCoordinate = (latitude: number, longitude: number): DynamicSpotRecord | null => {
    try { return records[dynamicSpotCoordinateKey(latitude, longitude)] ?? null; }
    catch { return null; }
  };

  const lookupByQuery = (query: string): DynamicSpotRecord | null => {
    const normalized = normalizeDynamicSpotSearchText(query);
    if (!normalized) return null;
    const matches = Object.values(records).filter((record) =>
      [record.name, ...record.aliases].some((name) => normalizeDynamicSpotSearchText(name) === normalized)
    );
    if (matches.length !== 1) return null;
    return matches[0];
  };

  const register = async (input: DynamicSpotRegistrationInput): Promise<DynamicSpotRecord> => {
    const coordinateKey = dynamicSpotCoordinateKey(input.latitude, input.longitude);
    const now = new Date().toISOString();
    const existing = records[coordinateKey];
    const betterHeight = !existing || heightQuality({ heightStatus: input.heightStatus }) >= heightQuality(existing);
    const aliases = Array.from(new Set([
      ...(existing?.aliases ?? []), input.name, ...input.aliases,
    ].map((value) => value.trim()).filter(Boolean))).slice(0, 20);
    const record: DynamicSpotRecord = {
      schemaVersion: DYNAMIC_SPOT_SCHEMA_VERSION,
      id: existing?.id ?? generatedId(coordinateKey),
      name: input.name.trim(),
      aliases,
      latitude: input.latitude,
      longitude: input.longitude,
      category: input.category || existing?.category || "unknown",
      subjectSurface: input.subjectSurface,
      structureHeightMeters: betterHeight ? input.structureHeightMeters : existing?.structureHeightMeters ?? null,
      heightSourceType: betterHeight ? input.heightSourceType : existing?.heightSourceType ?? "unknown",
      heightSourceUrl: betterHeight ? input.heightSourceUrl : existing?.heightSourceUrl ?? null,
      heightSourceLabel: betterHeight ? input.heightSourceLabel : existing?.heightSourceLabel ?? null,
      heightStatus: betterHeight ? input.heightStatus : existing?.heightStatus ?? "unknown",
      demProfileStatus: existing?.demProfileStatus === "complete" ? "complete" : existing?.demProfileStatus ?? "pending",
      maxDistanceMeters: DYNAMIC_SPOT_MAX_DISTANCE_METERS,
      bearingCount: DYNAMIC_SPOT_BEARING_COUNT,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      coordinateKey,
      profileVersion: DYNAMIC_SPOT_PROFILE_VERSION,
      completedBearings: existing?.completedBearings ?? 0,
      failedBearings: existing?.failedBearings ?? 0,
      currentStage: existing?.currentStage ?? "waiting",
      generationStartedAt: existing?.generationStartedAt ?? null,
      generationElapsedMs: existing?.generationElapsedMs ?? 0,
      lastError: existing?.lastError ?? null,
      profileBytes: existing?.profileBytes,
      profileSha256: existing?.profileSha256 ?? null,
    };
    await persistRecord(record);
    if (record.demProfileStatus !== "complete" && heightReady(record)) enqueue(coordinateKey);
    return record;
  };

  const retry = async (latitude: number, longitude: number): Promise<DynamicSpotRecord | null> => {
    const record = lookupByCoordinate(latitude, longitude);
    if (!record) return null;
    if (record.demProfileStatus !== "complete" && heightReady(record)) enqueue(record.coordinateKey);
    return record;
  };

  const lookupProfile = async (request: BearingProfileBatchRequest): Promise<BearingProfileBatchResponseV2 | null> => {
    const record = lookupByCoordinate(request.subjectPoint.latitude, request.subjectPoint.longitude);
    if (!record || record.demProfileStatus !== "complete" || !record.profileSha256 || !record.profileBytes) return null;
    const filePath = path.join(profileDirectory(record), "complete.json.gz");
    let bytes: Buffer;
    try { bytes = await readFile(filePath); } catch { return null; }
    if (bytes.length !== record.profileBytes || sha256(bytes) !== record.profileSha256) return null;
    let complete: CompleteDynamicProfile;
    try {
      complete = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1_048_576 }).toString("utf8")) as CompleteDynamicProfile;
    } catch { return null; }
    if (complete.format !== "astrosight-dynamic-spot-profile-v1" ||
      complete.dynamicSpot.coordinateKey !== record.coordinateKey ||
      complete.dynamicSpot.structureHeightMeters !== record.structureHeightMeters ||
      complete.dynamicSpot.subjectSurface !== record.subjectSurface) return null;
    const selected = selectPrecomputedBearingProfiles(complete.response, request.bearings);
    return selected && isPrecomputedBearingProfileResponse(selected, request) ? selected : null;
  };

  return {
    root,
    register,
    lookupByQuery,
    lookupByCoordinate,
    retry,
    lookupProfile,
    resumeIncomplete: () => {
      for (const record of Object.values(records)) {
        if (record.demProfileStatus !== "complete" && heightReady(record)) enqueue(record.coordinateKey);
      }
    },
  };
}

export const dynamicSpotStoreInternalsForTests = {
  STORE_DIRECTORY,
  MANIFEST_FORMAT,
  dynamicRootFromDataRoot,
  generatedId,
  isInside,
  validManifest,
  validStoredBearing,
};
