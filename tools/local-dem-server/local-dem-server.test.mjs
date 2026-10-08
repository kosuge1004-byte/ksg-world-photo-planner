import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { createLocalDemRequestHandler } from "./app.ts";
import { createReadOnlyBearingProfileStore } from "./readOnlyBearingProfileStore.ts";
import { createReadOnlyDemCache } from "./readOnlyDemCache.ts";
import { createLocalDemPersistentCache } from "./localDemPersistentCache.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  precomputedBearingProfileIdentity,
} from "../../server/precomputedBearingProfiles.ts";

const TOKEN = "b".repeat(48);
const ACCESS_ID = "client-id-1234567890";
const ACCESS_SECRET = "s".repeat(48);
const openServers = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  openServers.clear();
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
  temporaryDirectories.clear();
});

function config(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 8789,
    dataRoot: "unused-in-handler-test",
    originToken: TOKEN,
    maximumBodyBytes: 4_096,
    maximumPoints: 3,
    requestTimeoutMs: 500,
    profileRequestTimeoutMs: 500,
    maximumConcurrentRequests: 1,
    maximumQueuedRequests: 1,
    ...overrides,
  };
}

function point(index = 0) {
  return {
    index,
    latitude: 35.6812,
    longitude: 139.7671,
    interpolation: "bilinear",
    interpolationMode: "neutral",
  };
}

function autoPoint(index = 0) {
  return {
    index,
    latitude: 35.6812,
    longitude: 139.7671,
    maximumDetail: "1m",
    interpolationMode: "neutral",
  };
}

function payload(overrides = {}) {
  return { source: "DEM10B", points: [point()], ...overrides };
}

async function start(
  lookup,
  overrides = {},
  lookupAuto,
  lookupPrecomputedProfile,
  computeProfile,
  handlerOptions = {},
) {
  const handler = createLocalDemRequestHandler(
    config(overrides), lookup, lookupAuto, lookupPrecomputedProfile, computeProfile,
    undefined, handlerOptions
  );
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.add(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function postProfile(base, value, options = {}) {
  return fetch(`${base}/v1/bearing-profile/precomputed`, {
    method: "POST",
    headers: {
      "x-astrosight-origin-token": TOKEN,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(value),
  });
}

function postComputedProfile(base, value, options = {}) {
  return fetch(`${base}/v1/bearing-profile/compute`, {
    method: "POST",
    headers: {
      "x-astrosight-origin-token": TOKEN,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(value),
  });
}

function post(base, value, options = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return fetch(`${base}/v1/elevation/batch`, {
    method: "POST",
    headers: {
      "x-astrosight-origin-token": TOKEN,
      "cf-access-client-id": ACCESS_ID,
      "cf-access-client-secret": ACCESS_SECRET,
      "content-type": "application/json",
      ...options.headers,
    },
    body,
  });
}

test("authenticated batch returns aligned results and null for missing data", async () => {
  const base = await start(async (source, points) => {
    assert.equal(source, "DEM10B");
    assert.deepEqual(points.map((entry) => entry.index), [4, 9]);
    return new Map([[9, 12.34]]);
  });
  const response = await post(base, payload({ points: [point(4), point(9)] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    source: "DEM10B",
    results: [
      { index: 4, heightMeters: null },
      { index: 9, heightMeters: 12.34 },
    ],
    resolvedCount: 1,
  });
});

test("automatic batch returns final source decisions including authoritative NoData", async () => {
  const base = await start(
    async () => new Map(),
    {},
    async (points) => points.map((entry) => entry.index === 4
      ? { heightMeters: 12.34, source: "DEM5A" }
      : { heightMeters: null, source: null })
  );
  const response = await post(base, {
    mode: "auto",
    points: [autoPoint(4), autoPoint(9)],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    mode: "auto",
    complete: true,
    results: [
      { index: 4, heightMeters: 12.34, source: "DEM5A" },
      { index: 9, heightMeters: null, source: null },
    ],
  });
});

test("precomputed profile route is authenticated and returns one complete compact response", async () => {
  const profileRequest = {
    subjectPoint: { latitude: 35.3606255, longitude: 138.7273634, height: 0 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [0, 1],
    maxDistanceMeters: 10_000,
  };
  const responseBody = {
    version: 2,
    distancesMeters: [8, 10_000],
    profiles: profileRequest.bearings.map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [1, 2],
      elevationSources: ["DEM1A", "DEM10B"],
      computedAtIso: "2026-09-28T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: 2,
    pointCount: 4,
  };
  const base = await start(async () => new Map(), {}, undefined, async (actual) => {
    assert.deepEqual(actual, profileRequest);
    return responseBody;
  });
  assert.equal((await postProfile(base, profileRequest, {
    headers: { "x-astrosight-origin-token": "wrong" },
  })).status, 401);
  const response = await postProfile(base, profileRequest);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), responseBody);
});

test("computed profile route returns an exact complete profile for an arbitrary coordinate", async () => {
  const profileRequest = {
    subjectPoint: { latitude: 35.7101127, longitude: 139.8107504, height: 12 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [0, 1],
    maxDistanceMeters: 10_000,
  };
  const responseBody = {
    version: 2,
    distancesMeters: [8, 10_000],
    profiles: profileRequest.bearings.map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [101, 102],
      elevationSources: ["DEM1A", "DEM10B"],
      computedAtIso: "2026-09-30T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: 2,
    pointCount: 4,
  };
  const base = await start(async () => new Map(), {}, undefined, undefined, async (actual) => {
    assert.deepEqual(actual, profileRequest);
    return responseBody;
  });
  assert.equal((await postComputedProfile(base, profileRequest, {
    headers: { "x-astrosight-origin-token": "wrong" },
  })).status, 401);
  const response = await postComputedProfile(base, profileRequest);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...responseBody,
    terrainProfileComplete: true,
  });
});

test("nationwide completion raises only the exact-profile transport limit", async () => {
  const profileRequest = {
    subjectPoint: { latitude: 35.7101127, longitude: 139.8107504, height: 12 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: Array.from({ length: 120 }, (_, index) => index),
    maxDistanceMeters: 10_000,
  };
  const compute = async (actual) => ({
    version: 2,
    distancesMeters: [8, 10_000],
    profiles: actual.bearings.map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [101, 102],
      elevationSources: ["DEM1A", "DEM10B"],
      computedAtIso: "2026-10-08T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: actual.bearings.length,
    pointCount: actual.bearings.length * 2,
  });
  const legacyBase = await start(
    async () => new Map(), {}, undefined, undefined, compute
  );
  assert.equal((await postComputedProfile(legacyBase, profileRequest)).status, 400);

  const nationwideBase = await start(
    async () => new Map(), {}, undefined, undefined, compute,
    { nationwideDemReady: true }
  );
  const response = await postComputedProfile(nationwideBase, profileRequest);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requestedBearingCount, 120);
  assert.equal(body.terrainProfileComplete, true);
});

test("computed profile route rejects incomplete calculations", async () => {
  const profileRequest = {
    subjectPoint: { latitude: 35.7101127, longitude: 139.8107504, height: 12 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [0],
    maxDistanceMeters: 10_000,
  };
  const base = await start(async () => new Map(), {}, undefined, undefined, async () => ({
    version: 2,
    distancesMeters: [8, 10_000],
    profiles: [],
    failedBearings: [{ bearingDegrees: 0, reason: "missing" }],
    requestedBearingCount: 1,
    pointCount: 2,
  }));
  assert.equal((await postComputedProfile(base, profileRequest)).status, 503);
});

test("the independent origin token is enforced", async () => {
  const base = await start(async () => new Map());
  const missing = await fetch(`${base}/v1/elevation/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload()),
  });
  assert.equal(missing.status, 401);

  const wrong = await post(base, payload(), {
    headers: { "x-astrosight-origin-token": "wrong" },
  });
  assert.equal(wrong.status, 401);

  const accessOnly = await fetch(`${base}/v1/elevation/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-client-id": ACCESS_ID,
      "cf-access-client-secret": ACCESS_SECRET,
    },
    body: JSON.stringify(payload()),
  });
  assert.equal(accessOnly.status, 401);
  const originOnly = await fetch(`${base}/v1/elevation/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-astrosight-origin-token": TOKEN,
    },
    body: JSON.stringify(payload()),
  });
  assert.equal(originOnly.status, 200);
});

test("fixed route, POST, content type, JSON and unknown fields are strict", async () => {
  const base = await start(async () => new Map());
  assert.equal((await fetch(`${base}/v1/elevation/batch`)).status, 405);
  assert.equal((await fetch(`${base}/files`)).status, 404);
  assert.equal((await post(base, "{bad-json")).status, 400);
  assert.equal((await fetch(`${base}/v1/elevation/batch`, {
    method: "POST",
    headers: {
      "x-astrosight-origin-token": TOKEN,
      "cf-access-client-id": ACCESS_ID,
      "cf-access-client-secret": ACCESS_SECRET,
      "content-type": "text/plain",
    },
    body: JSON.stringify(payload()),
  })).status, 415);
  assert.equal((await post(base, { ...payload(), path: "E:\\private" })).status, 400);
  assert.equal((await post(base, payload({ points: [{ ...point(), file: "../secret" }] }))).status, 400);
  assert.equal((await post(base, payload({ source: "DEM10A" }))).status, 400);
  assert.equal((await post(base, { mode: "auto", source: "DEM10B", points: [autoPoint()] })).status, 400);
  assert.equal((await post(base, { mode: "auto", points: [{ ...autoPoint(), path: "E:\\private" }] })).status, 400);
});

test("body, point count, indexes and Japan coverage are bounded", async () => {
  const base = await start(async () => new Map(), { maximumBodyBytes: 512, maximumPoints: 2 });
  const oversized = await post(base, "x".repeat(513));
  assert.equal(oversized.status, 413);
  assert.equal((await post(base, payload({ points: [point(0), point(1), point(2)] }))).status, 400);
  assert.equal((await post(base, payload({ points: [point(1), point(1)] }))).status, 400);
  assert.equal((await post(base, payload({ points: [{ ...point(), latitude: 19.999 }] }))).status, 400);
  assert.equal((await post(base, payload({ points: [{ ...point(), longitude: "139.7" }] }))).status, 400);
});

test("global concurrency rejects excess work without an unbounded queue", async () => {
  let releaseFirst;
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const base = await start(async () => {
    entered();
    await holdFirst;
    return new Map();
  }, { maximumQueuedRequests: 0, requestTimeoutMs: 2_000 });

  const first = post(base, payload());
  await firstEntered;
  const second = await post(base, payload());
  assert.equal(second.status, 503);
  releaseFirst();
  assert.equal((await first).status, 200);
});

test("deadline aborts queued or running lookup", async () => {
  const base = await start(async (_source, _points, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return new Map();
  }, { requestTimeoutMs: 100 });
  const response = await post(base, payload());
  assert.equal(response.status, 504);
});

test("health contains no path, version, source inventory, or secret", async () => {
  const base = await start(async () => new Map());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("edge health requires the origin token and returns no origin details", async () => {
  const base = await start(async () => new Map());
  const unauthorized = await fetch(`${base}/v1/health`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${base}/v1/health`, {
    headers: { "x-astrosight-origin-token": TOKEN },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("read-only cache accepts only fixed R2 keys and blocks traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astrosight-local-dem-"));
  temporaryDirectories.add(root);
  const assetRoot = path.join(root, "gsi-local-dem-v1");
  await mkdir(path.join(assetRoot, "DEM10B"), { recursive: true });
  const manifestText = JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  });
  await writeFile(path.join(assetRoot, "manifest.json"), manifestText);
  await writeFile(path.join(assetRoot, "DEM10B", "533946.bin.gz"), "asset");
  await writeFile(path.join(root, "secret.txt"), "do-not-read");

  const cache = await createReadOnlyDemCache(root);
  assert.deepEqual(await cache.validateReady(), { nationwideReady: false });
  await writeFile(path.join(assetRoot, "nationwide-ready-v1.json"), JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-nationwide-dem-ready-v1",
    status: "complete",
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
  }));
  assert.deepEqual(await cache.validateReady(), { nationwideReady: true });
  assert.equal(new TextDecoder().decode(await cache.get(
    "gsi-local-dem-v1/DEM10B/533946.bin.gz",
    { type: "arrayBuffer" }
  )), "asset");
  await assert.rejects(
    cache.get("gsi-local-dem-v1/../secret.txt", { type: "arrayBuffer" }),
    /invalid DEM asset key/
  );
  await assert.rejects(
    cache.get("gsi-local-dem-v1/DEM10B/../../secret.txt", { type: "arrayBuffer" }),
    /invalid DEM asset key/
  );
  await assert.rejects(
    cache.put("anything", new ArrayBuffer(0)),
    /read-only/
  );
});

test("local persistent cache writes only fixed decoded-tile keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astrosight-local-dem-write-through-"));
  temporaryDirectories.add(root);
  const assetRoot = path.join(root, "gsi-local-dem-v1");
  await mkdir(assetRoot, { recursive: true });
  await writeFile(path.join(assetRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  }));
  const cache = await createLocalDemPersistentCache(root);
  await cache.validateReady();
  const key = "gsi-decoded-dem-v2/dem5a_png/15/29000/12800.bin";
  const payload = new Uint8Array([0]).buffer;
  await cache.put(key, payload);
  assert.deepEqual(new Uint8Array(await cache.get(key, { type: "arrayBuffer" })), new Uint8Array([0]));
  assert.equal((await cache.getWithStatus(key, { type: "arrayBuffer" })).status, "hit");
  await assert.rejects(cache.put("../outside.bin", payload), /invalid decoded DEM tile key/);
  await assert.rejects(
    cache.put("gsi-local-dem-v1/manifest.json", payload),
    /invalid decoded DEM tile key/
  );
});

test("read-only precomputed store verifies manifest, checksum and selects requested bearings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astrosight-profile-store-"));
  temporaryDirectories.add(root);
  const profileRoot = path.join(root, "precomputed-bearing-profile-v1");
  await mkdir(profileRoot, { recursive: true });
  const subject = { name: "test", latitude: 35.3606255, longitude: 138.7273634 };
  const maxDistanceMeters = 10_000;
  const identity = precomputedBearingProfileIdentity({ ...subject, maxDistanceMeters });
  const file = `${createHash("sha256").update(identity).digest("hex")}.json.gz`;
  const response = {
    version: 2,
    distancesMeters: [8, maxDistanceMeters],
    profiles: [0, 1, 2].map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [10 + bearingDegrees, 20 + bearingDegrees],
      elevationSources: ["DEM1A", "DEM5A"],
      computedAtIso: "2026-09-28T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: 3,
    pointCount: 6,
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
    subject,
    maxDistanceMeters,
    generatedAt: "2026-09-28T00:00:00.000Z",
    response,
  })));
  await writeFile(path.join(profileRoot, file), compressed);
  await writeFile(path.join(profileRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
    generatedAt: "2026-09-28T00:00:00.000Z",
    entries: {
      [identity]: {
        ...subject,
        maxDistanceMeters,
        file,
        bytes: compressed.length,
        sha256: createHash("sha256").update(compressed).digest("hex"),
        profileCount: 3,
        pointCount: 6,
      },
    },
  }));

  const store = await createReadOnlyBearingProfileStore(root);
  assert.ok(store);
  assert.equal(store.entryCount, 1);
  const selected = await store.lookup({
    subjectPoint: { latitude: subject.latitude, longitude: subject.longitude, height: 999 },
    cameraSettings: { lensCenterHeightMeters: 99 },
    bearings: [2, 0],
    maxDistanceMeters,
  });
  assert.deepEqual(selected.profiles.map((profile) => profile.bearingDegrees), [2, 0]);
  assert.equal(selected.pointCount, 4);
  assert.equal(await store.lookup({
    subjectPoint: { latitude: subject.latitude + 0.0001, longitude: subject.longitude, height: 0 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [0],
    maxDistanceMeters,
  }), null);
});
