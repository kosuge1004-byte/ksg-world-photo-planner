import type {
  BearingProfileBatchRequest,
  BearingProfileBatchResponseV2,
} from "../src/types/bearingProfileBatch.ts";
import { serverPersistentCache } from "./cloudflareRuntime.ts";
import { lookupLocalPrecomputedBearingProfile } from "./localDemGateway.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  isPrecomputedBearingProfileResponse,
  precomputedBearingProfileIdentity,
  precomputedBearingProfileObjectKey,
  selectPrecomputedBearingProfiles,
  type PrecomputedBearingProfileFile,
} from "./precomputedBearingProfiles.ts";

const MAX_COMPRESSED_PROFILE_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_PROFILE_BYTES = 32 * 1024 * 1024;

export type CompressedPrecomputedBearingProfile = {
  key: string;
  bytes: ArrayBuffer;
};

async function gunzipBounded(bytes: ArrayBuffer): Promise<Uint8Array> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_COMPRESSED_PROFILE_BYTES) {
    throw new Error("計算済み地形ファイルの圧縮サイズが不正です");
  }
  const body = new Response(bytes).body;
  if (!body) throw new Error("計算済み地形ファイルを読み込めません");
  const reader = body
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNCOMPRESSED_PROFILE_BYTES) {
        throw new Error("計算済み地形ファイルの展開サイズが上限を超えました");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validStoredFile(
  value: unknown,
  expectedIdentity: string
): value is PrecomputedBearingProfileFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<PrecomputedBearingProfileFile>;
  if (
    file.schemaVersion !== 1 ||
    file.format !== PRECOMPUTED_BEARING_PROFILE_FORMAT ||
    typeof file.subject !== "object" || file.subject === null ||
    typeof file.subject.name !== "string" || file.subject.name.length === 0 ||
    typeof file.subject.latitude !== "number" ||
    !Number.isFinite(file.subject.latitude) ||
    typeof file.subject.longitude !== "number" ||
    !Number.isFinite(file.subject.longitude) ||
    typeof file.maxDistanceMeters !== "number" ||
    !Number.isFinite(file.maxDistanceMeters) ||
    typeof file.generatedAt !== "string" ||
    typeof file.response !== "object" || file.response === null
  ) return false;
  const actualIdentity = precomputedBearingProfileIdentity({
    latitude: file.subject.latitude,
    longitude: file.subject.longitude,
    maxDistanceMeters: file.maxDistanceMeters,
  });
  if (actualIdentity !== expectedIdentity) return false;
  const storedBearings = Array.isArray(file.response.profiles)
    ? file.response.profiles.map((profile) => profile.bearingDegrees)
    : [];
  return isPrecomputedBearingProfileResponse(file.response, {
    bearings: storedBearings,
    maxDistanceMeters: file.maxDistanceMeters,
  });
}

/**
 * Reads a complete, immutable registered-spot profile from R2. One R2 object
 * contains all 360 one-degree bearings, so a phone download needs one R2 read
 * instead of tens of thousands of DEM tile/subrequest operations.
 */
export async function lookupR2PrecomputedBearingProfile(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal
): Promise<BearingProfileBatchResponseV2 | null> {
  const compressed = await readR2PrecomputedBearingProfileCompressed(request, signal);
  if (!compressed) return null;
  const identity = precomputedBearingProfileIdentity({
    latitude: request.subjectPoint.latitude,
    longitude: request.subjectPoint.longitude,
    maxDistanceMeters: request.maxDistanceMeters,
  });
  try {
    const raw = await gunzipBounded(compressed.bytes);
    if (signal?.aborted) throw signal.reason;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw)
    );
    if (!validStoredFile(value, identity)) return null;
    const selected = selectPrecomputedBearingProfiles(value.response, request.bearings);
    return selected && isPrecomputedBearingProfileResponse(selected, request)
      ? selected
      : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Returns the verified-key R2 payload without inflating or parsing it. Pages
 * uses this path to stream gzip directly to the browser and keep Worker CPU
 * usage inside the free-plan allowance.
 */
export async function readR2PrecomputedBearingProfileCompressed(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal
): Promise<CompressedPrecomputedBearingProfile | null> {
  if (signal?.aborted) throw signal.reason;
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return null;
  const key = await precomputedBearingProfileObjectKey({
    latitude: request.subjectPoint.latitude,
    longitude: request.subjectPoint.longitude,
    maxDistanceMeters: request.maxDistanceMeters,
  });
  const read = persistentCache.getWithStatus
    ? await persistentCache.getWithStatus(key, { type: "arrayBuffer" })
    : {
        status: "hit" as const,
        value: await persistentCache.get(key, { type: "arrayBuffer" }),
      };
  if (read.status !== "hit" || !(read.value instanceof ArrayBuffer)) return null;
  if (read.value.byteLength < 1 || read.value.byteLength > MAX_COMPRESSED_PROFILE_BYTES) {
    return null;
  }
  return { key, bytes: read.value };
}

/** R2 is the always-on source; the private E-drive origin remains an optional fallback. */
export async function lookupPublishedPrecomputedBearingProfile(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal
): Promise<BearingProfileBatchResponseV2 | null> {
  const published = await lookupR2PrecomputedBearingProfile(request, signal);
  if (published) return published;
  return lookupLocalPrecomputedBearingProfile(request, signal);
}
