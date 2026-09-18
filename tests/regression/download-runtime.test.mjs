import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBObjectStore } from "fake-indexeddb";
import { Cartographic } from "cesium";
import { AbortableSemaphore, CancellableRequestPool, withAbortableTimeout } from "../../src/utils/abortableSemaphore.ts";

globalThis.indexedDB = indexedDB;
globalThis.window ??= { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const context = {
  walkingAccessible: true, onMappedWay: true, restrictedAccess: false, onMotorRoad: false,
  onWaterSurface: false, waterSurfaceKind: "none", nearbyLandmarks: [], nearbyBuildings: [], nearbyStructures: [],
};
let elevationRequests = 0;
let geoidRequests = 0;
let activeGeoids = 0;
let maxActiveGeoids = 0;
const contextRequests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("/api/gsi-elevation")) {
    elevationRequests += 1;
    const points = JSON.parse(init.body).points;
    assert.ok(points.every((point) => point.maximumDetail === "1m" && point.interpolationMode === "neutral"));
    return json({ samples: points.map(() => ({ heightMeters: 100, source: "DEM5A" })) });
  }
  if (url.startsWith("/api/gsi-geoid")) {
    geoidRequests += 1;
    activeGeoids += 1;
    maxActiveGeoids = Math.max(maxActiveGeoids, activeGeoids);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeGeoids -= 1;
    if (init.signal?.aborted) throw init.signal.reason;
    return json({ geoidHeightMeters: 38, cache: "hit" });
  }
  if (url.startsWith("/api/gsi-dem-tile")) {
    if (new URL(url, "http://localhost").searchParams.get("source") !== "DEM5A") return new Response(null, { status: 404 });
    return new Response(new Int32Array(256 * 256).fill(10_000).buffer, {
      headers: { "x-astrosight-dem-width": "256", "x-astrosight-dem-height": "256" },
    });
  }
  if (url.startsWith("/api/osm-site-context")) {
    const request = JSON.parse(init.body);
    contextRequests.push(request);
    assert.ok(request.points.length <= (request.purpose === "water-only" ? 80 : 8));
    return json({ contexts: request.points.map(() => ({ ...context })) });
  }
  throw new Error(`Unexpected network request: ${url}`);
};

const terrain = await import("../../src/cesium/worldTerrain.ts");
const manager = await import("../../src/cache/tripodBearingProfileManager.ts");
const { fetchSiteContexts } = await import("../../src/search/siteContext.ts");
const strict = { allowWorldTerrainFallback: false };

test("a warm GSI terrain cache preserves source and exact ellipsoidal heights", async () => {
  const point = Cartographic.fromDegrees(136.8, 35.3);
  const first = await terrain.sampleWorldTerrainNeutral([point], undefined, "1m", strict);
  const calls = elevationRequests;
  const second = await terrain.sampleWorldTerrainNeutral([point], undefined, "1m", strict);
  assert.equal(elevationRequests, calls, "warm cache must not fetch DEM again");
  assert.equal(first[0].height, 138);
  assert.equal(second[0].height, first[0].height);
  assert.equal(terrain.terrainDataSource(second[0]), "GSI_DEM5A_LIDAR");
  assert.equal(terrain.geoidHeightMetersForTerrainSample(second[0]), 38);
});

async function seedTerrain(point, source) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("ksg-world-photo-planner-terrain-v3", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("terrain", "readwrite");
    tx.objectStore("terrain").put({
      key: `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)},1m,neutral`,
      height: 999, source, datum: "ellipsoidal-v1", updatedAt: Date.now(),
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test("legacy and World Terrain records cannot poison explicit GSI downloads", async () => {
  for (const [latitude, source] of [[35.31, undefined], [35.32, "CESIUM_WORLD_TERRAIN"]]) {
    const point = { latitude, longitude: 136.8 };
    await seedTerrain(point, source);
    const samples = await terrain.sampleWorldTerrainNeutral([
      Cartographic.fromDegrees(point.longitude, point.latitude),
    ], undefined, "1m", strict);
    assert.equal(samples[0].height, 138);
    assert.equal(terrain.terrainDataSource(samples[0]), "GSI_DEM5A_LIDAR");
  }
});

test("regional geoid misses serialize without changing coordinate values", async () => {
  const requested = Array.from({ length: 12 }, (_, i) => Cartographic.fromDegrees(137, 35.5 + i * 0.03));
  const heights = await Promise.all(requested.map((point) => terrain.fetchGsiGeoidHeight(point)));
  assert.ok(heights.every((height) => height === 38));
  assert.equal(maxActiveGeoids, 1);
});

test("point correction reaches cached server data while regional requests are queued", async () => {
  const original = globalThis.fetch;
  let releaseRegional;
  let regionalStarted;
  const started = new Promise((resolve) => { regionalStarted = resolve; });
  const urls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith("/api/gsi-geoid")) return original(input, init);
    urls.push(url);
    if (url.includes("precision=point")) return json({ geoidHeightMeters: 38.123, cache: "hit" });
    if (urls.length === 1) {
      regionalStarted();
      await new Promise((resolve) => { releaseRegional = resolve; });
      return json({ geoidHeightMeters: 38, cache: "miss" });
    }
    return json({ geoidHeightMeters: 38, cache: "hit" });
  };
  const controller = new AbortController();
  let queued;
  try {
    const regional = terrain.fetchGsiGeoidHeight(Cartographic.fromDegrees(138, 36));
    await started;
    queued = terrain.fetchGsiGeoidHeight(Cartographic.fromDegrees(138.03, 36), controller.signal);
    const rejected = assert.rejects(queued, { name: "AbortError" });
    assert.equal(await terrain.fetchGsiGeoidHeightPointSpecific(Cartographic.fromDegrees(138.0001, 36.0001), undefined, 1_200), 38.123);
    releaseRegional();
    await regional;
    // A preceding cache miss starts regional pacing, but the point cache must
    // remain reachable during that wait as well.
    assert.equal(await terrain.fetchGsiGeoidHeightPointSpecific(Cartographic.fromDegrees(138.0003, 36.0003), undefined, 1_200), 38.123);
    controller.abort();
    await rejected;
    assert.equal(urls.filter((url) => url.includes("precision=point")).length, 2);
    assert.equal(urls.filter((url) => !url.includes("precision=point")).length, 1);
  } finally { releaseRegional?.(); controller.abort(); globalThis.fetch = original; }
});

test("water downloads over 80 points use bounded batches and preserve order", async () => {
  const points = Array.from({ length: 161 }, (_, i) => ({ latitude: 34, longitude: 135 + i * 0.001 }));
  const start = contextRequests.length;
  const values = await fetchSiteContexts(points, undefined, false, "water-only");
  assert.equal(values.length, points.length);
  assert.deepEqual(contextRequests.slice(start).map((request) => request.points.length), [80, 80, 1]);
  assert.deepEqual(contextRequests.slice(start).flatMap((request) => request.points), points);
});

test("real bearing manager saves all required bearings and reuses them on the next run", async () => {
  const params = {
    subjectId: "download-runtime", subjectPoint: { latitude: 35.36, longitude: 136.81, height: 100, geoidHeightMeters: 38 },
    cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 }, maxDistanceMeters: 1_000,
  };
  const progress = [];
  const result = await manager.backfillBearingProfiles({ ...params, onProgress: (value) => progress.push(value) });
  const bearings = manager.requiredCelestialTripodBearings(params.subjectPoint.latitude);
  assert.equal(result.requestedBearings, bearings.length);
  assert.equal(result.successfulBearings, bearings.length);
  assert.equal(result.failedBearings, 0);
  assert.equal(result.storageWriteFailures, 0);
  assert.ok(result.profilePoints > bearings.length);
  assert.ok(progress.some((value) => value.geoidTotal > 0));
  assert.ok(contextRequests.some((request) => request.purpose === "water-only"));
  const { getBearingProfilesMany } = await import("../../src/cache/tripodBearingProfileCache.ts");
  const profiles = await getBearingProfilesMany(params.subjectId, 1.6, bearings);
  assert.ok(profiles.every((profile) => profile.points.at(-1).distanceMeters >= 1_000));
  assert.ok(profiles.every((profile) => profile.points.every((point) => point.ellipsoidalHeightMeters === 138)));
  const calls = elevationRequests;
  const geoids = geoidRequests;
  const reused = await manager.backfillBearingProfiles(params);
  assert.equal(reused.requestedBearings, 0);
  assert.equal(reused.storageWriteFailures, 0);
  assert.equal(elevationRequests, calls);
  assert.equal(geoidRequests, geoids);
  const { inspectDownloadedSpotStorage } = await import("../../src/cache/downloadedSpotDataStats.ts");
  const summary = await inspectDownloadedSpotStorage([{
    subjectId: params.subjectId, latitude: params.subjectPoint.latitude, longitude: params.subjectPoint.longitude,
    status: "complete", profilePoints: result.profilePoints, highPrecisionPoints: result.highPrecisionPoints,
    label: "runtime", downloadedAtIso: new Date().toISOString(),
  }]);
  assert.equal(summary.bySubjectId[params.subjectId].state, "complete",
    "required bearing count and real tile references must agree with successful download");
  assert.equal(summary.bySubjectId[params.subjectId].demExpiredTiles, 0);
});

test("cancelled queued requests never start, and repeated releases cannot oversubscribe", async () => {
  const slots = new AbortableSemaphore(1);
  const release = await slots.acquire();
  const controller = new AbortController();
  const cancelled = slots.acquire(controller.signal);
  const rejection = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  await rejection;
  let nextStarted = false;
  const next = slots.acquire().then((done) => { nextStarted = true; return done; });
  assert.equal(nextStarted, false);
  release();
  release();
  const done = await next;
  done();
});

test("timeout aborts the underlying operation and releases its slot", async () => {
  const slots = new AbortableSemaphore(1);
  let receivedSignal;
  const release = await slots.acquire();
  await assert.rejects(withAbortableTimeout(async (signal) => {
    receivedSignal = signal;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, 5, "test deadline").finally(release), { name: "TimeoutError" });
  assert.equal(receivedSignal.aborted, true);
  (await slots.acquire())();
});

test("a request deadline begins after its queue wait", async () => {
  const slots = new AbortableSemaphore(1);
  const release = await slots.acquire();
  const pending = (async () => {
    const done = await slots.acquire();
    try { return await withAbortableTimeout(async () => 42, 5, "deadline"); }
    finally { done(); }
  })();
  await new Promise((resolve) => setTimeout(resolve, 15));
  release();
  assert.equal(await pending, 42);
});

test("one cancelled consumer cannot cancel another consumer of the same geoid request", async () => {
  const pool = new CancellableRequestPool();
  let complete;
  let underlyingSignal;
  let started = 0;
  const factory = (signal) => {
    underlyingSignal = signal;
    started += 1;
    return new Promise((resolve) => { complete = resolve; });
  };
  const controller = new AbortController();
  const first = pool.request("region", controller.signal, factory);
  const second = pool.request("region", undefined, factory);
  await Promise.resolve();
  const rejection = assert.rejects(first, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(underlyingSignal.aborted, false);
  complete(38);
  assert.equal(await second, 38);
  assert.equal(started, 1);
});

test("the last cancelled consumer stops underlying work and a new run does not reuse it", async () => {
  const pool = new CancellableRequestPool();
  const controller = new AbortController();
  let underlyingSignal;
  const pending = pool.request("region", controller.signal, async (signal) => {
    underlyingSignal = signal;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  await Promise.resolve();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(underlyingSignal.aborted, true);
  assert.equal(await pool.request("region", undefined, async () => 39), 39);
});

test("uncommitted in-memory profiles cannot count as already downloaded after a write failure", async () => {
  const { setBearingProfile, getBearingProfilesMany, getBearingProfileWriteFailureCount } =
    await import("../../src/cache/tripodBearingProfileCache.ts");
  const before = getBearingProfileWriteFailureCount();
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (record) {
    const request = original.call(this, record);
    if (record.namespace === "tripod-bearing-profile-v1:failed-profile") this.transaction.abort();
    return request;
  };
  try {
    await setBearingProfile("failed-profile", 1.6, 0, {
      bearingDegrees: 0, computedAtIso: new Date().toISOString(),
      points: [{ latitude: 35, longitude: 136, distanceMeters: 1_000, ellipsoidalHeightMeters: 138 }],
    });
    assert.equal(getBearingProfileWriteFailureCount(), before + 1);
    assert.deepEqual(await getBearingProfilesMany("failed-profile", 1.6, [0]), [null]);
  } finally { IDBObjectStore.prototype.put = original; }
});

test("refresh preserves previous DEM references when metadata or tile reads fail", async () => {
  const tiles = await import("../../src/cesium/gsiDemTileCache.ts");
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("ksg-world-photo-planner-dem-tiles-v1", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readReference = () => new Promise((resolve, reject) => {
    const request = db.transaction("spotRefs", "readonly").objectStore("spotRefs").get("download-runtime");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const before = await readReference();
  assert.ok(before.tileKeys.length > 0);
  tiles.beginGsiDeviceTileCapture("download-runtime");
  const retained = await tiles.finishGsiDeviceTileCapture("download-runtime");
  assert.equal(retained.writeFailures, 0);
  assert.deepEqual(new Set((await readReference()).tileKeys), new Set(before.tileKeys));
  const original = IDBObjectStore.prototype.get;
  try {
    for (const failedStore of ["spotRefs", "tiles"]) {
      tiles.beginGsiDeviceTileCapture("download-runtime");
      IDBObjectStore.prototype.get = function (key) {
        const request = original.call(this, key);
        if (this.name === failedStore && this.transaction.mode === "readonly") this.transaction.abort();
        return request;
      };
      const failed = await tiles.finishGsiDeviceTileCapture("download-runtime");
      assert.ok(failed.writeFailures > 0);
      IDBObjectStore.prototype.get = original;
      assert.deepEqual(new Set((await readReference()).tileKeys), new Set(before.tileKeys));
    }
  } finally { IDBObjectStore.prototype.get = original; db.close(); }
});
