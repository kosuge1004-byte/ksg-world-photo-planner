import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { computeBearingProfileBatch } from "../server/bearingProfileBatch.ts";
import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { requiredCelestialTripodBearings } from "../src/cache/tripodBearingProfileManager.ts";

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const assetRoot = path.resolve(option(
  "asset-root",
  "E:/AstroSight-GSI-data-20260926/r2-benchmark",
));
const outputPath = path.resolve(option(
  "output",
  "evidence/local-bearing-profile-benchmark-20260926.json",
));
const subjectPoint = {
  // The downloaded Chubu DEM1 archive contains the complete 543753 second
  // mesh. This point is at its centre, with every 1 km bearing inside it.
  latitude: 36.458333333333336,
  longitude: 137.4375,
  height: 0,
};
const bearings = requiredCelestialTripodBearings(subjectPoint.latitude);
assert.equal(bearings.length, 259, "benchmark latitude must exercise the real 259-bearing set");

const counters = { reads: 0, hits: 0, misses: 0, writes: 0 };
const persistentCache = {
  async get(key) {
    const result = await this.getWithStatus(key);
    return result.value;
  },
  async getWithStatus(key) {
    counters.reads += 1;
    const filePath = path.join(assetRoot, ...key.split("/"));
    try {
      const bytes = await fs.readFile(filePath);
      counters.hits += 1;
      return { status: "hit", value: exactArrayBuffer(bytes) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      counters.misses += 1;
      return { status: "miss", value: null };
    }
  },
  async put() {
    counters.writes += 1;
    throw new Error("the local-only benchmark must not write fallback tiles");
  },
};

configureServerRuntime({ persistentCache });
const originalFetch = globalThis.fetch;
let externalFetches = 0;
globalThis.fetch = async (input) => {
  externalFetches += 1;
  throw new Error(`external network access is forbidden in the local benchmark: ${String(input)}`);
};

const request = {
  subjectPoint,
  cameraSettings: { lensCenterHeightMeters: 1.6 },
  bearings,
  maxDistanceMeters: 1_000,
};

async function run(label) {
  const before = { ...counters };
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const response = await computeBearingProfileBatch(request);
  const durationMs = performance.now() - startedAt;
  const responseBytes = Buffer.byteLength(JSON.stringify(response));
  const after = { ...counters };
  assert.equal(response.failedBearings.length, 0);
  assert.equal(response.profiles.length, bearings.length);
  assert.equal(response.pointCount, bearings.length * response.distancesMeters.length);
  assert.ok(response.profiles.every((profile) =>
    profile.elevationSources.every((source) => source === "DEM1A")
  ), `${label} run must be fully covered by the local DEM1 archive`);
  return {
    durationMs: Number(durationMs.toFixed(3)),
    responseBytes,
    pointCount: response.pointCount,
    distanceCount: response.distancesMeters.length,
    r2Reads: after.reads - before.reads,
    r2Hits: after.hits - before.hits,
    r2Misses: after.misses - before.misses,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
  };
}

try {
  const cold = await run("cold");
  const warm = await run("warm");
  assert.equal(externalFetches, 0, "local coverage must eliminate all GSI tile/CGI calls");
  assert.equal(counters.writes, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    assetRoot,
    subjectPoint,
    bearingCount: bearings.length,
    clientHttpRequestCountAt64Bearings: Math.ceil(bearings.length / 64),
    externalFetches,
    cold,
    warm,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  configureServerRuntime({});
}
