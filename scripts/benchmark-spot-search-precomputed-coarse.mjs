import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cartographic } from "cesium";

import { createPrecomputedSpotSearchTerrainSampler } from "../server/precomputedSpotSearchTerrain.ts";
import { calculateKarneyDestinationPoint } from "../src/geodesy/karneyGeodesic.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = process.env.LOCAL_DEM_BENCHMARK_URL ||
  "http://127.0.0.1:8789/v1/bearing-profile/precomputed";
const token = process.env.LOCAL_DEM_ORIGIN_TOKEN?.trim();
if (!token) throw new Error("LOCAL_DEM_ORIGIN_TOKEN is required");

const subject = {
  latitude: 35.7100627,
  longitude: 139.8107004,
  height: 634,
  label: "東京スカイツリー",
};
const request = {
  subjectPoint: subject,
  cameraSettings: { lensCenterHeightMeters: 1.6 },
  bearings: Array.from({ length: 360 }, (_, bearing) => bearing),
  maxDistanceMeters: 10_000,
};

async function loadProfile() {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-astrosight-origin-token": token,
    },
    body: JSON.stringify(request),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.status, 200);
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(payload.version, 2);
  assert.equal(payload.precomputed, true);
  assert.equal(payload.profiles.length, 360);
  assert.equal(payload.failedBearings.length, 0);
  return { payload, bytes: bytes.length, elapsedMs };
}

const cold = await loadProfile();
const warm = await loadProfile();
let exactCallCount = 0;
const sampler = createPrecomputedSpotSearchTerrainSampler(
  subject,
  warm.payload,
  async (points) => {
    exactCallCount += 1;
    return points.map((point) => {
      const sample = Cartographic.clone(point);
      sample.height = 777;
      return sample;
    });
  }
);

const selectedBearings = Array.from({ length: 36 }, (_, index) => index * 10);
const profileByBearing = new Map(
  warm.payload.profiles.map((profile) => [profile.bearingDegrees, profile])
);
const samples = [];
const expectedHeights = [];
for (const bearing of selectedBearings) {
  const profile = profileByBearing.get(bearing);
  assert.ok(profile);
  for (let distanceIndex = 0; distanceIndex < warm.payload.distancesMeters.length; distanceIndex += 1) {
    const distance = warm.payload.distancesMeters[distanceIndex];
    const destination = calculateKarneyDestinationPoint(subject, bearing, distance);
    samples.push(Cartographic.fromDegrees(destination.longitude, destination.latitude, 0));
    expectedHeights.push(profile.ellipsoidalHeightsMeters[distanceIndex]);
  }
}
const coarseStartedAt = performance.now();
const coarse = await sampler(samples, undefined, "10m");
const coarseMilliseconds = performance.now() - coarseStartedAt;
let maximumGridNodeErrorMeters = 0;
let maximumGridNodeErrorIndex = -1;
for (let index = 0; index < coarse.length; index += 1) {
  const error = Math.abs(coarse[index].height - expectedHeights[index]);
  if (error > maximumGridNodeErrorMeters) {
    maximumGridNodeErrorMeters = error;
    maximumGridNodeErrorIndex = index;
  }
}
assert.ok(
  maximumGridNodeErrorMeters < 0.00001,
  `profile grid-node interpolation error: ${maximumGridNodeErrorMeters}m at ${maximumGridNodeErrorIndex}`
);
assert.equal(exactCallCount, 0);

await sampler([samples[0]], undefined, "1m");
assert.equal(exactCallCount, 1, "1m final refinement must use the exact sampler");

const report = {
  generatedAt: new Date().toISOString(),
  status: "PASS",
  landmark: subject.label,
  bearingCount: request.bearings.length,
  terrainPointCount: warm.payload.pointCount,
  responseBytes: warm.bytes,
  coldProfileRequestMs: Number(cold.elapsedMs.toFixed(1)),
  warmProfileRequestMs: Number(warm.elapsedMs.toFixed(1)),
  coarseInterpolationPointCount: coarse.length,
  coarseInterpolationMs: Number(coarseMilliseconds.toFixed(1)),
  maximumGridNodeErrorMeters,
  exactOneMeterSamplerCalls: exactCallCount,
};
const output = path.join(repositoryRoot, "evidence", "spot-search-precomputed-coarse-benchmark.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
console.log(`report: ${output}`);
