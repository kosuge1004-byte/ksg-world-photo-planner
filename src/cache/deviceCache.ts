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
const lastNamespacePruneAt = new Map<string, number>();
const namespacePruneInFlight = new Map<string, Promise<void>>();

function compoundKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("namespace", "namespace", { unique: false });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return databasePromise;
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
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
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
  const record = await new Promise<CacheRecord<T> | null>((resolve) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
  if (!record) return null;
  if (record.expiresAt <= now) {
    void removePersistent(id);
    return null;
  }
  record.accessedAt = now;
  touchMemory(record, policy.memoryEntries ?? Math.min(policy.maxEntries, 256));
  return record.value;
}

async function pruneNamespaceNow(policy: DeviceCachePolicy): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  const records = await new Promise<Array<CacheRecord<unknown>>>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("namespace");
    const request = index.getAll(policy.namespace);
    request.onsuccess = () => resolve((request.result as Array<CacheRecord<unknown>>) ?? []);
    request.onerror = () => resolve([]);
  });
  const now = Date.now();
  const removeIds = records
    .filter((record) => record.expiresAt <= now)
    .map((record) => record.id);
  const live = records
    .filter((record) => record.expiresAt > now)
    .sort((left, right) => right.accessedAt - left.accessedAt);
  removeIds.push(...live.slice(policy.maxEntries).map((record) => record.id));
  if (removeIds.length === 0) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    removeIds.forEach((id) => store.delete(id));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
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
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
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
