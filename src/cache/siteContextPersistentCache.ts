import type { SiteContext } from "../types/geospatial";
import type { SiteContextPoint, SiteContextPurpose } from "../search/siteContext";

const DB_NAME = "astrosight-site-context-cache-v2";
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
  onblocked?: (() => void) | null;
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
  close: () => void;
  onversionchange?: (() => void) | null;
};

type IdbFactory = {
  open: (name: string, version: number) => IdbRequest<IdbDatabase>;
};

function keyFor(point: SiteContextPoint, purpose: SiteContextPurpose, includeDetails: boolean): string {
  return `${purpose}:${includeDetails ? 1 : 0}:${point.latitude.toFixed(5)}:${point.longitude.toFixed(5)}`;
}

let databasePromise: Promise<IdbDatabase | null> | null = null;
let cachedDatabase: IdbDatabase | null = null;
let persistentWriteFailures = 0;
export function getPersistentSiteContextWriteFailureCount(): number { return persistentWriteFailures; }

function boundedContextOperation<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), 1_500);
    void operation.then((value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); });
  });
}

function openDb(): Promise<IdbDatabase | null> {
  const indexedDb = (globalThis as unknown as { indexedDB?: IdbFactory }).indexedDB;
  if (!indexedDb) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  const opening = new Promise<IdbDatabase | null>((resolve) => {
    let settled = false;
    const finish = (db: IdbDatabase | null) => {
      if (settled) { db?.close(); return; }
      settled = true;
      clearTimeout(timer);
      if (db) cachedDatabase = db;
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), 1_500);
    let req: IdbRequest<IdbDatabase>;
    try { req = indexedDb.open(DB_NAME, DB_VERSION); }
    catch { finish(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(REF_STORE)) db.createObjectStore(REF_STORE, { keyPath: "subjectId" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => invalidateDatabase(db);
      finish(db);
    };
    req.onerror = () => finish(null);
    req.onblocked = () => finish(null);
  });
  databasePromise = opening;
  void opening.then((db) => { if (!db && databasePromise === opening) databasePromise = null; });
  return opening;
}

function invalidateDatabase(db: IdbDatabase): void {
  if (cachedDatabase === db) {
    cachedDatabase = null;
    databasePromise = null;
  }
  try { db.close(); } catch { /* The connection may already be closed. */ }
}

function contextTransaction(db: IdbDatabase, stores: string | string[], mode: "readonly" | "readwrite"): IdbTransaction | null {
  try { return db.transaction(stores, mode); }
  catch {
    // WebView can invalidate a cached connection without a versionchange event.
    // Treat that as a cache miss/failure and let the next operation open a new one.
    invalidateDatabase(db);
    return null;
  }
}

export async function readPersistentSiteContexts(points: SiteContextPoint[], purpose: SiteContextPurpose, includeDetails: boolean): Promise<Array<SiteContext | null>> {
  const db = await openDb();
  if (!db) return points.map(() => null);
  const now = Date.now();
  const tx = contextTransaction(db, STORE, "readonly");
  if (!tx) return points.map(() => null);
  const store = tx.objectStore(STORE);
  return boundedContextOperation(Promise.all(points.map((point) => new Promise<SiteContext | null>((resolve) => {
    const req = store.get(keyFor(point, purpose, includeDetails));
    req.onsuccess = () => {
      const value = req.result as Cached | undefined;
      resolve(value && now - value.storedAt <= TTL_MS ? value.context : null);
    };
    req.onerror = () => resolve(null);
  }))), points.map(() => null));
}

export async function writePersistentSiteContexts(points: SiteContextPoint[], contexts: SiteContext[], purpose: SiteContextPurpose, includeDetails: boolean, subjectId?: string): Promise<void> {
  const db = await openDb();
  if (!db || points.length !== contexts.length) { persistentWriteFailures += 1; return; }
  const keys = points.map((point) => keyFor(point, purpose, includeDetails));
  const dataWritten = await boundedContextOperation(new Promise<boolean>((resolve) => {
    const tx = contextTransaction(db, STORE, "readwrite");
    if (!tx) { resolve(false); return; }
    const store = tx.objectStore(STORE);
    contexts.forEach((context, i) => store.put({ key: keys[i], context, storedAt: Date.now() } satisfies Cached));
    tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false); tx.onabort = () => resolve(false);
  }), false);
  if (!dataWritten) { persistentWriteFailures += 1; return; }
  if (!subjectId) return;
  const refsWritten = await boundedContextOperation(new Promise<boolean>((resolve) => {
    const tx = contextTransaction(db, REF_STORE, "readwrite");
    if (!tx) { resolve(false); return; }
    const store = tx.objectStore(REF_STORE);
    const get = store.get(subjectId);
    get.onsuccess = () => {
      const old = get.result as SpotRefs | undefined;
      store.put({ subjectId, keys: [...new Set([...(old?.keys ?? []), ...keys])] } satisfies SpotRefs);
    };
    get.onerror = () => resolve(false);
    tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false); tx.onabort = () => resolve(false);
  }), false);
  if (!refsWritten) persistentWriteFailures += 1;
}


function estimateJsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
}

export async function getPersistentSiteContextStatsForSpot(subjectId: string): Promise<{ referencedCount: number; liveCount: number; bytes: number; expiredCount: number }> {
  const db = await openDb();
  if (!db) return { referencedCount: 0, liveCount: 0, bytes: 0, expiredCount: 0 };
  const refs = await boundedContextOperation(new Promise<SpotRefs | null>((resolve) => {
    const tx = contextTransaction(db, REF_STORE, "readonly");
    if (!tx) { resolve(null); return; }
    const req = tx.objectStore(REF_STORE).get(subjectId);
    req.onsuccess = () => resolve((req.result as SpotRefs | undefined) ?? null);
    req.onerror = () => resolve(null);
  }), null);
  const keys = refs?.keys ?? [];
  if (keys.length === 0) return { referencedCount: 0, liveCount: 0, bytes: 0, expiredCount: 0 };
  const now = Date.now();
  let liveCount = 0;
  let expiredCount = 0;
  let bytes = 0;
  const tx = contextTransaction(db, STORE, "readonly");
  if (!tx) return { referencedCount: keys.length, liveCount: 0, bytes: 0, expiredCount: keys.length };
  const store = tx.objectStore(STORE);
  const readsCompleted = await boundedContextOperation(Promise.all(keys.map((key) => new Promise<void>((resolve) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const value = req.result as Cached | undefined;
      if (!value || now - value.storedAt > TTL_MS) expiredCount += 1;
      else { liveCount += 1; bytes += estimateJsonBytes(value.context); }
      resolve();
    };
    req.onerror = () => { expiredCount += 1; resolve(); };
  }))).then(() => true), false);
  // A timeout leaves some records unknown. They must request an update rather
  // than making a partially inspected spot appear complete.
  if (!readsCompleted) expiredCount = Math.max(expiredCount, keys.length - liveCount);
  return { referencedCount: keys.length, liveCount, bytes, expiredCount };
}

export async function getPersistentSiteContextTotalStorageStats(): Promise<{ uniqueLiveCount: number; bytes: number }> {
  const db = await openDb();
  if (!db) return { uniqueLiveCount: 0, bytes: 0 };
  const refs = await boundedContextOperation(new Promise<SpotRefs[]>((resolve) => {
    const tx = contextTransaction(db, REF_STORE, "readonly");
    if (!tx) { resolve([]); return; }
    const req = tx.objectStore(REF_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as SpotRefs[]);
    req.onerror = () => resolve([]);
  }), []);
  const keys = [...new Set(refs.flatMap((r) => r.keys))];
  const now = Date.now();
  let uniqueLiveCount = 0;
  let bytes = 0;
  const tx = contextTransaction(db, STORE, "readonly");
  if (!tx) return { uniqueLiveCount: 0, bytes: 0 };
  const store = tx.objectStore(STORE);
  await boundedContextOperation(Promise.all(keys.map((key) => new Promise<void>((resolve) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const value = req.result as Cached | undefined;
      if (value && now - value.storedAt <= TTL_MS) { uniqueLiveCount += 1; bytes += estimateJsonBytes(value.context); }
      resolve();
    };
    req.onerror = () => resolve();
  }))).then(() => undefined), undefined);
  return { uniqueLiveCount, bytes };
}

export async function deletePersistentSiteContextsForSpot(subjectId: string): Promise<{ deleted: number; retainedShared: number }> {
  const db = await openDb();
  if (!db) return { deleted: 0, retainedShared: 0 };
  const refs = await new Promise<SpotRefs[]>((resolve) => {
    const tx = contextTransaction(db, REF_STORE, "readonly");
    if (!tx) throw new Error("保存データの読み出しに失敗しました。再実行してください");
    const req = tx.objectStore(REF_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as SpotRefs[]); req.onerror = () => resolve([]);
  });
  const target = refs.find((r) => r.subjectId === subjectId);
  if (!target) return { deleted: 0, retainedShared: 0 };
  const other = new Set(refs.filter((r) => r.subjectId !== subjectId).flatMap((r) => r.keys));
  const deletable = target.keys.filter((k) => !other.has(k));
  await new Promise<void>((resolve) => {
    const tx = contextTransaction(db, [STORE, REF_STORE], "readwrite");
    if (!tx) throw new Error("保存データの削除に失敗しました。再実行してください");
    const store = tx.objectStore(STORE); deletable.forEach((k) => store.delete(k));
    tx.objectStore(REF_STORE).delete(subjectId);
    tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
  });
  return { deleted: deletable.length, retainedShared: target.keys.length - deletable.length };
}
