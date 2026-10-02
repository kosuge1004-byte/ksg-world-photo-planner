import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { BearingProfileBatchRequest, BearingProfileBatchResponseV2 } from "../../src/types/bearingProfileBatch.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_DIRECTORY,
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  isPrecomputedBearingProfileResponse,
  precomputedBearingProfileIdentity,
  selectPrecomputedBearingProfiles,
  type PrecomputedBearingProfileFile,
  type PrecomputedBearingProfileManifest,
} from "../../server/precomputedBearingProfiles.ts";

const FILE_NAME = /^[a-f0-9]{64}\.json\.gz$/;
const MAX_MANIFEST_BYTES = 2 * 1_048_576;
const MAX_COMPRESSED_PROFILE_BYTES = 16 * 1_048_576;
const MAX_UNCOMPRESSED_PROFILE_BYTES = 64 * 1_048_576;
const MAX_MEMORY_ENTRIES = 8;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validManifest(value: unknown): value is PrecomputedBearingProfileManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<PrecomputedBearingProfileManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.format !== PRECOMPUTED_BEARING_PROFILE_FORMAT ||
    typeof manifest.generatedAt !== "string" ||
    typeof manifest.entries !== "object" || manifest.entries === null
  ) return false;
  return Object.entries(manifest.entries).every(([identity, entry]) =>
    typeof entry === "object" && entry !== null &&
    identity === precomputedBearingProfileIdentity(entry) &&
    typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 200 &&
    Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude) &&
    Number.isFinite(entry.maxDistanceMeters) && entry.maxDistanceMeters >= 8 && entry.maxDistanceMeters <= 100_000 &&
    FILE_NAME.test(entry.file) &&
    Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_COMPRESSED_PROFILE_BYTES &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    Number.isSafeInteger(entry.profileCount) && entry.profileCount > 0 && entry.profileCount <= 360 &&
    Number.isSafeInteger(entry.pointCount) && entry.pointCount > 0
  );
}

export type ReadOnlyBearingProfileStore = {
  lookup(request: BearingProfileBatchRequest): Promise<BearingProfileBatchResponseV2 | null>;
  entryCount: number;
};

export async function createReadOnlyBearingProfileStore(
  configuredRoot: string
): Promise<ReadOnlyBearingProfileStore | null> {
  const dataRoot = await realpath(path.resolve(configuredRoot));
  const root = path.resolve(dataRoot, PRECOMPUTED_BEARING_PROFILE_DIRECTORY);
  if (!isInside(dataRoot, root)) throw new Error("invalid precomputed profile root");
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("precomputed profile root is unavailable");
  }
  if (!isInside(dataRoot, canonicalRoot)) throw new Error("invalid precomputed profile root");
  const manifestPath = path.resolve(canonicalRoot, "manifest.json");
  if (!isInside(canonicalRoot, manifestPath)) throw new Error("invalid precomputed manifest path");
  const manifestMeta = await stat(manifestPath);
  if (!manifestMeta.isFile() || manifestMeta.size < 1 || manifestMeta.size > MAX_MANIFEST_BYTES) {
    throw new Error("precomputed profile manifest is invalid");
  }
  const manifestHandle = await open(manifestPath, constants.O_RDONLY);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await manifestHandle.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await manifestHandle.close();
  }
  if (!validManifest(manifest)) throw new Error("precomputed profile manifest is invalid");

  const cache = new Map<string, PrecomputedBearingProfileFile>();
  const load = async (identity: string): Promise<PrecomputedBearingProfileFile | null> => {
    const cached = cache.get(identity);
    if (cached) {
      cache.delete(identity);
      cache.set(identity, cached);
      return cached;
    }
    const entry = manifest.entries[identity];
    if (!entry) return null;
    const candidate = path.resolve(canonicalRoot, entry.file);
    if (!isInside(canonicalRoot, candidate)) throw new Error("invalid precomputed profile path");
    const canonical = await realpath(candidate);
    if (!isInside(canonicalRoot, canonical)) throw new Error("invalid precomputed profile path");
    const metadata = await stat(canonical);
    if (!metadata.isFile() || metadata.size !== entry.bytes || metadata.size > MAX_COMPRESSED_PROFILE_BYTES) {
      throw new Error("precomputed profile file is invalid");
    }
    const handle = await open(canonical, constants.O_RDONLY);
    let compressed: Buffer;
    try {
      compressed = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (sha256(compressed) !== entry.sha256) throw new Error("precomputed profile checksum mismatch");
    const raw = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_PROFILE_BYTES });
    const value = JSON.parse(raw.toString("utf8")) as PrecomputedBearingProfileFile;
    if (
      value.schemaVersion !== 1 || value.format !== PRECOMPUTED_BEARING_PROFILE_FORMAT ||
      precomputedBearingProfileIdentity({ ...value.subject, maxDistanceMeters: value.maxDistanceMeters }) !== identity ||
      !isPrecomputedBearingProfileResponse(value.response, {
        bearings: value.response.profiles.map((profile) => profile.bearingDegrees),
        maxDistanceMeters: value.maxDistanceMeters,
      })
    ) throw new Error("precomputed profile content is invalid");
    cache.set(identity, value);
    while (cache.size > MAX_MEMORY_ENTRIES) cache.delete(cache.keys().next().value as string);
    return value;
  };

  return {
    entryCount: Object.keys(manifest.entries).length,
    lookup: async (request) => {
      const identity = precomputedBearingProfileIdentity({
        latitude: request.subjectPoint.latitude,
        longitude: request.subjectPoint.longitude,
        maxDistanceMeters: request.maxDistanceMeters,
      });
      const stored = await load(identity);
      if (!stored) return null;
      const selected = selectPrecomputedBearingProfiles(stored.response, request.bearings);
      return selected && isPrecomputedBearingProfileResponse(selected, request) ? selected : null;
    },
  };
}

export const readOnlyBearingProfileStoreInternalsForTests = {
  FILE_NAME,
  isInside,
  validManifest,
};
