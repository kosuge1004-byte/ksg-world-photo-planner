import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBObjectStore } from "fake-indexeddb";

let latestConnection;
let openCount = 0;
globalThis.indexedDB = {
  open(name, version) {
    openCount += 1;
    const request = indexedDB.open(name, version);
    request.addEventListener("success", () => { latestConnection = request.result; });
    return request;
  },
};
globalThis.window ??= { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const context = {
  walkingAccessible: true, onMappedWay: true, restrictedAccess: false, onMotorRoad: false,
  onWaterSurface: false, waterSurfaceKind: "none", nearbyLandmarks: [], nearbyBuildings: [], nearbyStructures: [],
};
const cache = await import("../../src/cache/siteContextPersistentCache.ts");

test("an invalidated cache connection becomes a miss and the next read recovers saved data", async () => {
  const points = [{ latitude: 35.1, longitude: 136.1 }];
  await cache.writePersistentSiteContexts(points, [context], "water-only", false, "connection-read");
  const opened = openCount;
  latestConnection.close();
  assert.deepEqual(await cache.readPersistentSiteContexts(points, "water-only", false), [null]);
  assert.deepEqual(await cache.readPersistentSiteContexts(points, "water-only", false), [context]);
  assert.equal(openCount, opened + 1, "the closed connection must be replaced once");
  const stats = await cache.getPersistentSiteContextStatsForSpot("connection-read");
  assert.equal(stats.referencedCount, 1);
  assert.equal(stats.liveCount, 1, "saved ownership references must survive reconnecting");
});

test("a write on an invalidated connection is reported as a failure and a retry persists", async () => {
  const points = [{ latitude: 35.2, longitude: 136.2 }];
  const changedContext = { ...context, onWaterSurface: true, waterSurfaceKind: "river" };
  const before = cache.getPersistentSiteContextWriteFailureCount();
  latestConnection.close();
  await cache.writePersistentSiteContexts(points, [changedContext], "water-only", false, "connection-write");
  assert.equal(cache.getPersistentSiteContextWriteFailureCount(), before + 1);
  await cache.writePersistentSiteContexts(points, [changedContext], "water-only", false, "connection-write");
  assert.deepEqual(await cache.readPersistentSiteContexts(points, "water-only", false), [changedContext]);
  assert.equal(cache.getPersistentSiteContextWriteFailureCount(), before + 1, "a successful retry must not add failures");
  assert.equal((await cache.getPersistentSiteContextStatsForSpot("connection-write")).liveCount, 1);
});

test("a stale connection does not prevent authoritative context fetch and the result is cached", async () => {
  const points = [{ latitude: 35.3, longitude: 136.3 }];
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/osm-site-context");
    assert.deepEqual(JSON.parse(init.body).points, points);
    requests += 1;
    return new Response(JSON.stringify({ contexts: [context] }), { headers: { "Content-Type": "application/json" } });
  };
  const { fetchSiteContexts } = await import("../../src/search/siteContext.ts");
  latestConnection.close();
  assert.deepEqual(await fetchSiteContexts(points, undefined, false, "water-only"), [context]);
  assert.deepEqual(await fetchSiteContexts(points, undefined, false, "water-only"), [context]);
  assert.equal(requests, 1, "the recovered cache must avoid a second network request");
});

test("storage inspection recovers after a stale connection without changing persisted ownership", async () => {
  latestConnection.close();
  assert.deepEqual(await cache.getPersistentSiteContextStatsForSpot("connection-read"), {
    referencedCount: 0, liveCount: 0, bytes: 0, expiredCount: 0,
  });
  const recovered = await cache.getPersistentSiteContextStatsForSpot("connection-read");
  assert.equal(recovered.referencedCount, 1);
  assert.equal(recovered.liveCount, 1);
  assert.equal(recovered.expiredCount, 0);
  assert.ok((await cache.getPersistentSiteContextTotalStorageStats()).uniqueLiveCount >= 2);
});

test("a partially stalled storage inspection treats unread records as needing an update", async () => {
  const points = [{ latitude: 35.4, longitude: 136.4 }, { latitude: 35.5, longitude: 136.5 }];
  await cache.writePersistentSiteContexts(points, [context, context], "water-only", false, "inspection-timeout");
  const originalGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) {
    if (this.name === "contexts" && key === "water-only:0:35.50000:136.50000") {
      // The browser never delivers this request's success/error event.
      return { result: undefined, onsuccess: null, onerror: null };
    }
    return originalGet.call(this, key);
  };
  try {
    const partial = await cache.getPersistentSiteContextStatsForSpot("inspection-timeout");
    assert.equal(partial.referencedCount, 2);
    assert.equal(partial.liveCount, 1);
    assert.equal(partial.expiredCount, 1, "a live first record cannot hide an unread second record");
  } finally {
    IDBObjectStore.prototype.get = originalGet;
  }
  const recovered = await cache.getPersistentSiteContextStatsForSpot("inspection-timeout");
  assert.equal(recovered.liveCount, 2);
  assert.equal(recovered.expiredCount, 0);
});
