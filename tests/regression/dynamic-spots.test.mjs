import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DYNAMIC_SPOT_BEARING_COUNT,
  dynamicSpotCoordinateKey,
  isDynamicSpotRecord,
} from "../../src/types/dynamicSpot.ts";
import {
  createDynamicSpotStore,
  dynamicSpotStoreInternalsForTests,
} from "../../tools/local-dem-server/dynamicSpotStore.ts";
import { localDemAppInternalsForTests } from "../../tools/local-dem-server/app.ts";
import { handleDynamicSpotApi } from "../../functions/_shared/dynamicSpotApi.ts";

function input(overrides = {}) {
  return {
    name: "未登録テスト地点",
    aliases: ["動的地点"],
    latitude: 35.1234567,
    longitude: 136.7654321,
    category: "natural/peak",
    subjectSurface: "terrain",
    structureHeightMeters: 0,
    heightSourceType: "unknown",
    heightSourceUrl: null,
    heightSourceLabel: null,
    heightStatus: "unknown",
    maxDistanceMeters: 10_000,
    bearingCount: 360,
    ...overrides,
  };
}

function successfulCompute(counter = { calls: 0 }) {
  return async (request) => {
    counter.calls += 1;
    const distancesMeters = [8, 1_000, 10_000];
    return {
      version: 2,
      terrainProfileComplete: true,
      distancesMeters,
      profiles: request.bearings.map((bearing) => ({
        bearingDegrees: bearing,
        ellipsoidalHeightsMeters: distancesMeters.map((distance) =>
          30 + bearing / 100 + distance / 100_000
        ),
        elevationSources: distancesMeters.map(() => "DEM5A"),
        computedAtIso: new Date().toISOString(),
      })),
      failedBearings: [],
      requestedBearingCount: request.bearings.length,
      pointCount: request.bearings.length * distancesMeters.length,
    };
  };
}

async function temporaryDataRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "astrosight-dynamic-spots-"));
  await mkdir(root, { recursive: true });
  return root;
}

async function waitFor(store, latitude, longitude, predicate, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const record = store.lookupByCoordinate(latitude, longitude);
    if (record && predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("dynamic spot state did not converge");
}

test("A terrain: an unregistered point is persisted and becomes complete only at 360/360", async () => {
  const root = await temporaryDataRoot();
  const store = await createDynamicSpotStore(root, successfulCompute());
  const created = await store.register(input());
  assert.equal(created.coordinateKey, dynamicSpotCoordinateKey(created.latitude, created.longitude));
  const complete = await waitFor(store, created.latitude, created.longitude,
    (record) => record.demProfileStatus === "complete");
  assert.equal(complete.completedBearings, DYNAMIC_SPOT_BEARING_COUNT);
  assert.match(complete.profileSha256, /^[a-f0-9]{64}$/);
  assert.ok((complete.profileBytes ?? 0) > 0);
  assert.ok(isDynamicSpotRecord(complete));
  await stat(path.join(store.root, "manifest.json"));
  await stat(path.join(store.root, "spots", `${complete.id}.json`));
});

test("B/C structure provenance: PLATEAU and OSM sources remain distinct and both generate exact profiles", async () => {
  for (const provenance of [
    { type: "plateau-measured", status: "measured", name: "PLATEAU構造物", offset: 0 },
    { type: "osm-height", status: "estimated", name: "OSM構造物", offset: 0.01 },
  ]) {
    const root = await temporaryDataRoot();
    const store = await createDynamicSpotStore(root, successfulCompute());
    const created = await store.register(input({
      name: provenance.name,
      latitude: 35.2 + provenance.offset,
      subjectSurface: "structure",
      structureHeightMeters: 42.5,
      heightSourceType: provenance.type,
      heightSourceUrl: provenance.type === "plateau-measured"
        ? "https://www.mlit.go.jp/plateau/"
        : "https://www.openstreetmap.org/",
      heightSourceLabel: provenance.name,
      heightStatus: provenance.status,
    }));
    const complete = await waitFor(store, created.latitude, created.longitude,
      (record) => record.demProfileStatus === "complete");
    assert.equal(complete.heightSourceType, provenance.type);
    assert.equal(complete.heightStatus, provenance.status);
    assert.equal(complete.structureHeightMeters, 42.5);
  }
});

test("D unresolved structure is recorded without invented zero height and never becomes complete", async () => {
  const root = await temporaryDataRoot();
  const counter = { calls: 0 };
  const store = await createDynamicSpotStore(root, successfulCompute(counter));
  const created = await store.register(input({
    name: "高さ不明の建物",
    subjectSurface: "structure",
    structureHeightMeters: null,
    heightSourceType: "unknown",
    heightStatus: "unknown",
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stored = store.lookupByCoordinate(created.latitude, created.longitude);
  assert.equal(stored?.structureHeightMeters, null);
  assert.equal(stored?.demProfileStatus, "pending");
  assert.equal(counter.calls, 0);
});

test("E/H completed data is reused without external recalculation", async () => {
  const root = await temporaryDataRoot();
  const counter = { calls: 0 };
  const store = await createDynamicSpotStore(root, successfulCompute(counter));
  const created = await store.register(input());
  await waitFor(store, created.latitude, created.longitude, (record) => record.demProfileStatus === "complete");
  const firstCalls = counter.calls;
  await store.register(input({ aliases: ["別名"] }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(counter.calls, firstCalls);
  assert.equal(store.lookupByQuery("別名")?.coordinateKey, created.coordinateKey);
});

test("F partial generation resumes after restart and skips successful bearings", async () => {
  const root = await temporaryDataRoot();
  let firstCalls = 0;
  const partialStore = await createDynamicSpotStore(root, async (request) => {
    firstCalls += 1;
    const base = await successfulCompute()(request);
    if (firstCalls <= 2) return base;
    return {
      ...base,
      profiles: [],
      failedBearings: request.bearings.map((bearing) => ({ bearingDegrees: bearing, reason: "interrupted" })),
    };
  });
  const created = await partialStore.register(input());
  const partial = await waitFor(partialStore, created.latitude, created.longitude,
    (record) => record.currentStage === "failed");
  assert.equal(partial.completedBearings, 48);

  const resumedCounter = { calls: 0 };
  const resumedStore = await createDynamicSpotStore(root, successfulCompute(resumedCounter));
  resumedStore.resumeIncomplete();
  const complete = await waitFor(resumedStore, created.latitude, created.longitude,
    (record) => record.demProfileStatus === "complete");
  assert.equal(complete.completedBearings, 360);
  assert.equal(resumedCounter.calls, 13, "only the remaining 312 bearings are calculated in 24-bearing chunks");
});

test("PC service automatically retries an incomplete Dynamic Spot without a phone request", async () => {
  const root = await temporaryDataRoot();
  let calls = 0;
  const compute = successfulCompute();
  const store = await createDynamicSpotStore(root, async (request) => {
    calls += 1;
    if (calls === 1) throw new Error("transient DEM failure");
    return compute(request);
  }, { autoRetryBaseMs: 5, autoRetryMaxMs: 20 });
  const created = await store.register(input({ latitude: 35.2234567 }));
  const complete = await waitFor(store, created.latitude, created.longitude,
    (record) => record.demProfileStatus === "complete");
  assert.equal(complete.completedBearings, 360);
  assert.ok(calls > 15, "the missing first chunk was retried by the PC-owned timer");
});

test("public retry endpoint cannot operate the E-drive queue", async () => {
  const response = await handleDynamicSpotApi({
    request: new Request("https://astrosight.pages.dev/api/dynamic-spot-retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latitude: 35.1, longitude: 136.1 }),
    }),
  }, "retry");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "DYNAMIC_SPOT_RETRY_AUTOMATIC");
});

test("I/L adjacent coordinates get separate spot identities while sharing the external DEM cache layer", async () => {
  const root = await temporaryDataRoot();
  const store = await createDynamicSpotStore(root, successfulCompute());
  const first = await store.register(input());
  const second = await store.register(input({ latitude: 35.1234568, name: "隣接地点" }));
  assert.notEqual(first.coordinateKey, second.coordinateKey);
  assert.notEqual(first.id, second.id);
  await waitFor(store, first.latitude, first.longitude, (record) => record.demProfileStatus === "complete");
  await waitFor(store, second.latitude, second.longitude, (record) => record.demProfileStatus === "complete");
  // The dynamic store contains profiles only. Decoded DEM tiles stay in the
  // single gsi-decoded-dem-v2 namespace owned by LocalDemPersistentCache.
  const manifestText = await readFile(path.join(store.root, "manifest.json"), "utf8");
  assert.doesNotMatch(manifestText, /gsi-decoded-dem-v2[\\/].*dynamic-/);
});

test("M an incomplete response cannot be marked complete", async () => {
  const root = await temporaryDataRoot();
  const store = await createDynamicSpotStore(root, async (request) => ({
    version: 2,
    distancesMeters: [8, 10_000],
    profiles: [],
    failedBearings: request.bearings.map((bearing) => ({ bearingDegrees: bearing, reason: "NoData" })),
    requestedBearingCount: request.bearings.length,
    pointCount: request.bearings.length * 2,
  }));
  const created = await store.register(input());
  const failed = await waitFor(store, created.latitude, created.longitude,
    (record) => record.currentStage === "failed");
  assert.notEqual(failed.demProfileStatus, "complete");
  assert.equal(failed.completedBearings, 0);
});

test("N HTTP payload parsers reject caller supplied paths and filenames", () => {
  assert.throws(() => localDemAppInternalsForTests.parseDynamicSpotRegistrationPayload(
    Buffer.from(JSON.stringify({ ...input(), path: "E:\\secret.txt" }))
  ));
  assert.throws(() => localDemAppInternalsForTests.parseDynamicSpotLookupPayload(
    Buffer.from(JSON.stringify({ query: "地点", directory: ".." }))
  ));
});

test("G PC unavailable keeps the local Dynamic Spot usable and pending", async () => {
  const data = new Map();
  const originalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    get length() { return data.size; },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "offline" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  try {
    const dynamicCache = await import("../../src/cache/dynamicSpotData.ts");
    const local = await dynamicCache.createPendingLocalDynamicSpot(input());
    dynamicCache.upsertLocalDynamicSpot(local);
    assert.equal(await dynamicCache.registerEdriveDynamicSpot(input()), null);
    assert.equal(dynamicCache.findLocalDynamicSpotByQuery("動的地点")?.coordinateKey, local.coordinateKey);
    assert.equal(dynamicCache.findLocalDynamicSpotByQuery("動的地点")?.demProfileStatus, "pending");
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    globalThis.fetch = originalFetch;
  }
});

test("O old DownloadedSpotData records remain readable without migration", async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    get length() { return data.size; },
  };
  const legacy = {
    subjectId: "35.1,136.1",
    label: "旧データ",
    latitude: 35.1,
    longitude: 136.1,
    downloadedAtIso: new Date().toISOString(),
    status: "complete",
    profilePoints: 100,
    highPrecisionPoints: 100,
  };
  localStorage.setItem("astrosight-downloaded-spot-data-v1", JSON.stringify([legacy]));
  const { listDownloadedSpotData } = await import("../../src/cache/downloadedSpotData.ts");
  assert.deepEqual(listDownloadedSpotData(), [legacy]);
  delete globalThis.localStorage;
});

test("fixed store root never accepts an HTTP supplied path", async () => {
  const root = await temporaryDataRoot();
  assert.equal(dynamicSpotStoreInternalsForTests.dynamicRootFromDataRoot(root), path.join(root, "dynamic-spots-v1"));
});
