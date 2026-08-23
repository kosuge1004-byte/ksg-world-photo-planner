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
          // キャッシュの削除失敗（バケット未整備・一時的な障害など）を、
          // レスポンス確定後の「捕捉されない例外」としてWorker全体を
          // クラッシュさせない（Cloudflare Error 1101の原因になりうる）。
          // 削除に失敗しても、次回同じキーを読んだ際にバージョン不一致
          // または期限切れとして扱われ、そのまま再生成されるだけなので
          // 探索結果には影響しない。
          waitUntil?.(bucket.delete(key).catch(() => undefined));
        } catch {
          waitUntil?.(bucket.delete(key).catch(() => undefined));
        }
      }
      const value = await producer();
      const envelope: CacheEnvelope<T> = {
        version: options.version,
        expiresAt: Date.now() + options.ttlSeconds * 1000,
        value,
      };
      // キャッシュへの書き込み失敗（バケット未作成・権限・R2側の一時的な
      // 障害など）も同様に、レスポンスそのものを失敗させたり、Worker全体を
      // クラッシュさせたりしない。書き込みが失敗しても、計算結果自体
      // （value）は既に確定しており、単に次回また同じ計算を行うだけになる。
      const write = bucket.put(key, JSON.stringify(envelope), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          version: options.version,
          expiresAt: String(envelope.expiresAt),
        },
      }).catch(() => undefined);
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
