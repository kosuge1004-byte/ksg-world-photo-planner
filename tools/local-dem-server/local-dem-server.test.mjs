import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createLocalDemRequestHandler } from "./app.ts";
import { createReadOnlyDemCache } from "./readOnlyDemCache.ts";

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

function payload(overrides = {}) {
  return { source: "DEM10B", points: [point()], ...overrides };
}

async function start(lookup, overrides = {}) {
  const handler = createLocalDemRequestHandler(config(overrides), lookup);
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.add(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
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

test("read-only cache accepts only fixed R2 keys and blocks traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astrosight-local-dem-"));
  temporaryDirectories.add(root);
  const assetRoot = path.join(root, "gsi-local-dem-v1");
  await mkdir(path.join(assetRoot, "DEM10B"), { recursive: true });
  await writeFile(path.join(assetRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    format: "astrosight-gsi-local-dem-v1",
  }));
  await writeFile(path.join(assetRoot, "DEM10B", "533946.bin.gz"), "asset");
  await writeFile(path.join(root, "secret.txt"), "do-not-read");

  const cache = await createReadOnlyDemCache(root);
  await cache.validateReady();
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
