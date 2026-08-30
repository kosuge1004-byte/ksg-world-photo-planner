export type DeviceCachePolicy = {
  namespace: string;
  ttlMs: number;
  maxEntries: number;
  memoryEntries?: number;
};

type CacheRecord<T> = {
  id: string;
  namespace: string;
  key: string;
  value: T;
  createdAt: number;
  accessedAt: number;
  expiresAt: number;
};

const DB_NAME = "astrosight-device-cache-v1";
const STORE_NAME = "entries";
const memory = new Map<string, CacheRecord<unknown>>();
let databasePromise: Promise<IDBDatabase | null> | null = null;
const PRUNE_INTERVAL_MS = 60_000;
// IndexedDB is a performance cache only. Some Android WebView/PWA environments can
// leave open/transaction requests pending indefinitely (for example while a DB is
// blocked by another context). Never let that stall an authoritative calculation.
const INDEXED_DB_OPEN_TIMEOUT_MS = 1_500;
const INDEXED_DB_OPERATION_TIMEOUT_MS = 1_500;
const lastNamespacePruneAt = new Map<string, number>();
const namespacePruneInFlight = new Map<string, Promise<void>>();

function compoundKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  const opening = new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        if (database) database.close();
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(database);
    };
    const timeoutId = globalThis.setTimeout(() => finish(null), INDEXED_DB_OPEN_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("namespace", "namespace", { unique: false });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
  databasePromise = opening;
  void opening.then((database) => {
    // A failed/blocked/timed-out open must not poison every later cache access with
    // the same permanently pending Promise. Later calls may retry normally.
    if (!database && databasePromise === opening) databasePromise = null;
  });
  return opening;
}

function boundedCacheOperation<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = globalThis.setTimeout(
      () => finish(fallback),
      INDEXED_DB_OPERATION_TIMEOUT_MS
    );
    void operation.then(finish, () => finish(fallback));
  });
}

function touchMemory<T>(record: CacheRecord<T>, maximum: number): void {
  memory.delete(record.id);
  memory.set(record.id, record as CacheRecord<unknown>);
  while (memory.size > maximum) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }
}

async function removePersistent(id: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await boundedCacheOperation(
    new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    }),
    undefined
  );
}

export async function getDeviceCache<T>(
  policy: DeviceCachePolicy,
  key: string
): Promise<T | null> {
  const id = compoundKey(policy.namespace, key);
  const now = Date.now();
  const cached = memory.get(id) as CacheRecord<T> | undefined;
  if (cached) {
    if (cached.expiresAt <= now) {
      memory.delete(id);
      void removePersistent(id);
      return null;
    }
    cached.accessedAt = now;
    touchMemory(cached, policy.memoryEntries ?? Math.min(policy.maxEntries, 256));
    return cached.value;
  }
  const database = await openDatabase();
  if (!database) return null;
  const record = await boundedCacheOperation(
    new Promise<CacheRecord<T> | null>((resolve) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined) ?? null);
      request.onerror = () => resolve(null);
    }),
    null
  );
  if (!record) return null;
  if (record.expiresAt <= now) {
    void removePersistent(id);
    return null;
  }
  record.accessedAt = now;
  touchMemory(record, policy.memoryEntries ?? Math.min(policy.maxEntries, 256));
  return record.value;
}

/**
 * Read multiple keys with one IndexedDB readonly transaction. Memory/expiry/LRU
 * semantics are identical to getDeviceCache(); only transaction overhead changes.
 * Returned array preserves input order.
 */
export async function getDeviceCacheMany<T>(
  policy: DeviceCachePolicy,
  keys: readonly string[]
): Promise<Array<T | null>> {
  if (keys.length === 0) return [];
  const now = Date.now();
  const results: Array<T | null> = keys.map(() => null);
  const missing: Array<{ index: number; id: string }> = [];

  keys.forEach((key, index) => {
    const id = compoundKey(policy.namespace, key);
    const cached = memory.get(id) as CacheRecord<T> | undefined;
    if (!cached) {
      missing.push({ index, id });
      return;
    }
    if (cached.expiresAt <= now) {
      memory.delete(id);
      void removePersistent(id);
      return;
    }
    cached.accessedAt = now;
    touchMemory(cached, policy.memoryEntries ?? Math.min(policy.maxEntries, 256));
    results[index] = cached.value;
  });

  if (missing.length === 0) return results;
  const database = await openDatabase();
  if (!database) return results;

  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  await boundedCacheOperation(
    Promise.all(missing.map(({ index, id }) => new Promise<void>((resolve) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = (request.result as CacheRecord<T> | undefined) ?? null;
        if (!record) {
          resolve();
          return;
        }
        if (record.expiresAt <= now) {
          void removePersistent(id);
          resolve();
          return;
        }
        record.accessedAt = now;
        touchMemory(record, policy.memoryEntries ?? Math.min(policy.maxEntries, 256));
        results[index] = record.value;
        resolve();
      };
      request.onerror = () => resolve();
    })),
    []
  );
  return results;
}

async function pruneNamespaceNow(policy: DeviceCachePolicy): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  const records = await boundedCacheOperation(
    new Promise<Array<CacheRecord<unknown>>>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const index = transaction.objectStore(STORE_NAME).index("namespace");
      const request = index.getAll(policy.namespace);
      request.onsuccess = () => resolve((request.result as Array<CacheRecord<unknown>>) ?? []);
      request.onerror = () => resolve([]);
    }),
    []
  );
  const now = Date.now();
  const removeIds = records
    .filter((record) => record.expiresAt <= now)
    .map((record) => record.id);
  const live = records
    .filter((record) => record.expiresAt > now)
    .sort((left, right) => right.accessedAt - left.accessedAt);
  removeIds.push(...live.slice(policy.maxEntries).map((record) => record.id));
  if (removeIds.length === 0) return;
  await boundedCacheOperation(
    new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      removeIds.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    }),
    undefined
  );
  removeIds.forEach((id) => memory.delete(id));
}

async function scheduleNamespacePrune(policy: DeviceCachePolicy): Promise<void> {
  const now = Date.now();
  const lastPrunedAt = lastNamespacePruneAt.get(policy.namespace) ?? 0;
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  const existing = namespacePruneInFlight.get(policy.namespace);
  if (existing) return existing;
  lastNamespacePruneAt.set(policy.namespace, now);
  const pruning = pruneNamespaceNow(policy).finally(() => {
    if (namespacePruneInFlight.get(policy.namespace) === pruning) {
      namespacePruneInFlight.delete(policy.namespace);
    }
  });
  namespacePruneInFlight.set(policy.namespace, pruning);
  return pruning;
}

/**
 * 2026-08-29追記: 三脚候補の永続seedキャッシュ（tripodCandidateSeedCache.ts）
 * が、一度誤って確定した候補を「seed」として保存し続け、以後の検索へ
 * 繰り返し悪影響を与える事例が実機で確認された。TTL（最大30日）を
 * 待たずに、該当namespaceの永続データを利用者の操作で即座に消せるよう、
 * 名前空間単位の完全削除を用意する。値そのものを解釈しないため、
 * どのキャッシュ用途にも汎用的に使える。
 */
export async function clearDeviceCacheNamespace(namespace: string): Promise<void> {
  for (const id of Array.from(memory.keys())) {
    if (memory.get(id)?.namespace === namespace) memory.delete(id);
  }
  const database = await openDatabase();
  if (!database) return;
  const ids = await boundedCacheOperation(
    new Promise<string[]>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const index = transaction.objectStore(STORE_NAME).index("namespace");
      const request = index.getAllKeys(namespace);
      request.onsuccess = () => resolve((request.result as string[]) ?? []);
      request.onerror = () => resolve([]);
    }),
    []
  );
  if (ids.length === 0) return;
  await boundedCacheOperation(
    new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      ids.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    }),
    undefined
  );
}

export async function setDeviceCache<T>(
  policy: DeviceCachePolicy,
  key: string,
  value: T,
  ttlMs = policy.ttlMs
): Promise<void> {
  const now = Date.now();
  const record: CacheRecord<T> = {
    id: compoundKey(policy.namespace, key),
    namespace: policy.namespace,
    key,
    value,
    createdAt: now,
    accessedAt: now,
    expiresAt: now + ttlMs,
  };
  touchMemory(record, policy.memoryEntries ?? Math.min(policy.maxEntries, 256));
  const database = await openDatabase();
  if (!database) return;
  await boundedCacheOperation(
    new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    }),
    undefined
  );
  await scheduleNamespacePrune(policy);
}


export async function setDeviceCacheMany<T>(
  policy: DeviceCachePolicy,
  entries: ReadonlyArray<{ key: string; value: T; ttlMs?: number }>
): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  const maximum = policy.memoryEntries ?? Math.min(policy.maxEntries, 256);
  const records = entries.map(({ key, value, ttlMs }) => ({
    id: compoundKey(policy.namespace, key),
    namespace: policy.namespace,
    key,
    value,
    createdAt: now,
    accessedAt: now,
    expiresAt: now + (ttlMs ?? policy.ttlMs),
  } satisfies CacheRecord<T>));
  for (const record of records) touchMemory(record, maximum);
  const database = await openDatabase();
  if (!database) return;
  await boundedCacheOperation(
    new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    }),
    undefined
  );
  await scheduleNamespacePrune(policy);
}

export async function migrateLegacyLocalStorage<T>(options: {
  policy: DeviceCachePolicy;
  key: string;
  legacyKey: string;
  parse: (raw: string) => { value: T; expiresAt: number } | null;
}): Promise<T | null> {
  const current = await getDeviceCache<T>(options.policy, options.key);
  if (current !== null) return current;
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(options.legacyKey);
    if (!raw) return null;
    const parsed = options.parse(raw);
    localStorage.removeItem(options.legacyKey);
    if (!parsed || parsed.expiresAt <= Date.now()) return null;
    await setDeviceCache(options.policy, options.key, parsed.value, parsed.expiresAt - Date.now());
    return parsed.value;
  } catch {
    return null;
  }
}
