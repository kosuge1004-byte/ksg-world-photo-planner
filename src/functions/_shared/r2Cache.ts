export interface R2JsonCacheOptions {
  namespace: string;
  version: string;
  ttlSeconds: number;
}

interface CacheEnvelope<T> {
  version: string;
  expiresAt: number;
  value: T;
}

const inFlight = new Map<string, Promise<unknown>>();

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
  input: unknown,
  options: R2JsonCacheOptions,
  producer: () => Promise<T>,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<{ value: T; cache: "hit" | "miss" | "bypass" | "shared" }> {
  if (!bucket) return { value: await producer(), cache: "bypass" };
  const key = await cacheKey(options, input);
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return { value: await existing, cache: "shared" };

  const task = (async () => {
    try {
      const object = await bucket.get(key);
      if (object) {
        try {
          const envelope = await object.json<CacheEnvelope<T>>();
          if (envelope.version === options.version && envelope.expiresAt > Date.now()) {
            return envelope.value;
          }
          waitUntil?.(bucket.delete(key));
        } catch {
          waitUntil?.(bucket.delete(key));
        }
      }
      const value = await producer();
      const envelope: CacheEnvelope<T> = {
        version: options.version,
        expiresAt: Date.now() + options.ttlSeconds * 1000,
        value,
      };
      const write = bucket.put(key, JSON.stringify(envelope), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          version: options.version,
          expiresAt: String(envelope.expiresAt),
        },
      });
      if (waitUntil) {
        waitUntil(write);
      } else {
        await write;
      }
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  const hadObject = await bucket.head(key).catch(() => null);
  return { value: await task, cache: hadObject ? "hit" : "miss" };
}
