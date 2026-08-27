import {
  allowR2Read,
  reserveR2Write,
  valueBytes,
  type R2SafetyKv,
} from "../../server/r2SafetyBudget.ts";
import { serverR2WriteBudgetDb } from "../../server/cloudflareRuntime.ts";

export interface R2JsonCacheOptions {
  namespace: string;
  version: string;
  /** null/undefined = application-level non-expiring cache. */
  ttlSeconds?: number | null;
}

interface CacheEnvelope<T> {
  version: string;
  expiresAt: number | null;
  value: T;
}

const inFlight = new Map<string, Promise<{ value: unknown; cache: "hit" | "miss" }>>();

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cacheKey(options: R2JsonCacheOptions, input: unknown): Promise<string> {
  return `phase5/${options.namespace}/${options.version}/${await sha256(stableSerialize(input))}.json`;
}

export async function getOrCreateR2Json<T>(
  bucket: R2Bucket | undefined,
  safetyKv: R2SafetyKv | undefined,
  requestIdentity: object | undefined,
  input: unknown,
  options: R2JsonCacheOptions,
  producer: () => Promise<T>,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<{ value: T; cache: "hit" | "miss" | "bypass" | "shared" }> {
  if (!bucket || !safetyKv) return { value: await producer(), cache: "bypass" };

  const key = await cacheKey(options, input);
  const existing = inFlight.get(key);
  if (existing) {
    const shared = await existing;
    return { value: shared.value as T, cache: "shared" };
  }

  const task = (async (): Promise<{ value: T; cache: "hit" | "miss" }> => {
    try {
      if (await allowR2Read(safetyKv, requestIdentity)) {
        const object = await bucket.get(key).catch(() => null);
        if (object) {
          try {
            const envelope = await object.json<CacheEnvelope<T>>();
            if (
              envelope.version === options.version &&
              (envelope.expiresAt === null || envelope.expiresAt === undefined || envelope.expiresAt > Date.now())
            ) {
              return { value: envelope.value, cache: "hit" };
            }
          } catch {
            // Malformed cache objects are treated as misses.
            // No unguarded delete: a guarded overwrite below replaces them.
          }
        }
      }

      const value = await producer();
      const envelope: CacheEnvelope<T> = {
        version: options.version,
        expiresAt: typeof options.ttlSeconds === "number"
          ? Date.now() + options.ttlSeconds * 1000
          : null,
        value,
      };
      const serialized = JSON.stringify(envelope);
      const newBytes = valueBytes(serialized);

      if (await reserveR2Write(safetyKv, key, newBytes, requestIdentity, serverR2WriteBudgetDb())) {
        const write = bucket.put(key, serialized, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            version: options.version,
            expiresAt: envelope.expiresAt === null ? "none" : String(envelope.expiresAt),
          },
        }).catch(() => undefined);
        if (waitUntil) waitUntil(write);
        else await write;
      }

      return { value, cache: "miss" };
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task as Promise<{ value: unknown; cache: "hit" | "miss" }>);
  return await task;
}
