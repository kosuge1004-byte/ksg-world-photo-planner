import type { SiteContext } from "../types/geospatial";
import type { SiteContextPoint, SiteContextPurpose } from "../search/siteContext";

const DB_NAME = "astrosight-site-context-cache-v1";
const DB_VERSION = 1;
const STORE = "contexts";
const REF_STORE = "spot-refs";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Cached = { key: string; context: SiteContext; storedAt: number };
type SpotRefs = { subjectId: string; keys: string[] };

type IdbRequest<T> = {
  result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};

type IdbStore = {
  get: (key: string) => IdbRequest<unknown>;
  put: (value: unknown) => IdbRequest<unknown>;
  delete: (key: string) => IdbRequest<unknown>;
  getAll: () => IdbRequest<unknown>;
};

type IdbTransaction = {
  objectStore: (name: string) => IdbStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

type IdbDatabase = {
  objectStoreNames: { contains: (name: string) => boolean };
  createObjectStore: (name: string, options: { keyPath: string }) => IdbStore;
  transaction: (name: string | string[], mode: "readonly" | "readwrite") => IdbTransaction;
};

type IdbFactory = {
  open: (name: string, version: number) => IdbRequest<IdbDatabase>;
};

function keyFor(point: SiteContextPoint, purpose: SiteContextPurpose, includeDetails: boolean): string {
  return `${purpose}:${includeDetails ? 1 : 0}:${point.latitude.toFixed(5)}:${point.longitude.toFixed(5)}`;
}

function openDb(): Promise<IdbDatabase | null> {
  const indexedDb = (globalThis as unknown as { indexedDB?: IdbFactory }).indexedDB;
  if (!indexedDb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(REF_STORE)) db.createObjectStore(REF_STORE, { keyPath: "subjectId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function readPersistentSiteContexts(points: SiteContextPoint[], purpose: SiteContextPurpose, includeDetails: boolean): Promise<Array<SiteContext | null>> {
  const db = await openDb();
  if (!db) return points.map(() => null);
  const now = Date.now();
  return Promise.all(points.map((point) => new Promise<SiteContext | null>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(keyFor(point, purpose, includeDetails));
    req.onsuccess = () => {
      const value = req.result as Cached | undefined;
      resolve(value && now - value.storedAt <= TTL_MS ? value.context : null);
    };
    req.onerror = () => resolve(null);
  })));
}

export async function writePersistentSiteContexts(points: SiteContextPoint[], contexts: SiteContext[], purpose: SiteContextPurpose, includeDetails: boolean, subjectId?: string): Promise<void> {
  const db = await openDb();
  if (!db || points.length !== contexts.length) return;
  const keys = points.map((point) => keyFor(point, purpose, includeDetails));
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    contexts.forEach((context, i) => store.put({ key: keys[i], context, storedAt: Date.now() } satisfies Cached));
    tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
  });
  if (!subjectId) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(REF_STORE, "readwrite");
    const store = tx.objectStore(REF_STORE);
    const get = store.get(subjectId);
    get.onsuccess = () => {
      const old = get.result as SpotRefs | undefined;
      store.put({ subjectId, keys: [...new Set([...(old?.keys ?? []), ...keys])] } satisfies SpotRefs);
    };
    tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
  });
}


function estimateJsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
}

export async function getPersistentSiteContextStatsForSpot(subjectId: string): Promise<{ referencedCount: number; liveCount: number; bytes: number; expiredCount: number }> {
  const db = await openDb();
  if (!db) return { referencedCount: 0, liveCount: 0, bytes: 0, expiredCount: 0 };
  const refs = await new Promise<SpotRefs | null>((resolve) => {
    const tx = db.transaction(REF_STORE, "readonly");
    const req = tx.objectStore(REF_STORE).get(subjectId);
    req.onsuccess = () => resolve((req.result as SpotRefs | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
  const keys = refs?.keys ?? [];
  if (keys.length === 0) return { referencedCount: 0, liveCount: 0, bytes: 0, expiredCount: 0 };
  const now = Date.now();
  let liveCount = 0;
  let expiredCount = 0;
  let bytes = 0;
  await Promise.all(keys.map((key) => new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const value = req.result as Cached | undefined;
      if (!value || now - value.storedAt > TTL_MS) expiredCount += 1;
      else { liveCount += 1; bytes += estimateJsonBytes(value.context); }
      resolve();
    };
    req.onerror = () => { expiredCount += 1; resolve(); };
  })));
  return { referencedCount: keys.length, liveCount, bytes, expiredCount };
}

export async function getPersistentSiteContextTotalStorageStats(): Promise<{ uniqueLiveCount: number; bytes: number }> {
  const db = await openDb();
  if (!db) return { uniqueLiveCount: 0, bytes: 0 };
  const refs = await new Promise<SpotRefs[]>((resolve) => {
    const tx = db.transaction(REF_STORE, "readonly");
    const req = tx.objectStore(REF_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as SpotRefs[]);
    req.onerror = () => resolve([]);
  });
  const keys = [...new Set(refs.flatMap((r) => r.keys))];
  const now = Date.now();
  let uniqueLiveCount = 0;
  let bytes = 0;
  await Promise.all(keys.map((key) => new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const value = req.result as Cached | undefined;
      if (value && now - value.storedAt <= TTL_MS) { uniqueLiveCount += 1; bytes += estimateJsonBytes(value.context); }
      resolve();
    };
    req.onerror = () => resolve();
  })));
  return { uniqueLiveCount, bytes };
}

export async function deletePersistentSiteContextsForSpot(subjectId: string): Promise<{ deleted: number; retainedShared: number }> {
  const db = await openDb();
  if (!db) return { deleted: 0, retainedShared: 0 };
  const refs = await new Promise<SpotRefs[]>((resolve) => {
    const tx = db.transaction(REF_STORE, "readonly"); const req = tx.objectStore(REF_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as SpotRefs[]); req.onerror = () => resolve([]);
  });
  const target = refs.find((r) => r.subjectId === subjectId);
  if (!target) return { deleted: 0, retainedShared: 0 };
  const other = new Set(refs.filter((r) => r.subjectId !== subjectId).flatMap((r) => r.keys));
  const deletable = target.keys.filter((k) => !other.has(k));
  await new Promise<void>((resolve) => {
    const tx = db.transaction([STORE, REF_STORE], "readwrite");
    const store = tx.objectStore(STORE); deletable.forEach((k) => store.delete(k));
    tx.objectStore(REF_STORE).delete(subjectId);
    tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
  });
  return { deleted: deletable.length, retainedShared: target.keys.length - deletable.length };
}
