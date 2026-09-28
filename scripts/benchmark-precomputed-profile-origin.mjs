import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const endpoint = process.env.LOCAL_DEM_BENCHMARK_URL ||
  "http://127.0.0.1:8789/v1/bearing-profile/precomputed";
const token = process.env.LOCAL_DEM_ORIGIN_TOKEN?.trim();
if (!token) throw new Error("LOCAL_DEM_ORIGIN_TOKEN is required");

const request = {
  subjectPoint: {
    latitude: 35.7100627,
    longitude: 139.8107004,
    height: 634,
    label: "東京スカイツリー",
  },
  cameraSettings: { lensCenterHeightMeters: 1.6 },
  bearings: Array.from({ length: 259 }, (_, index) => index),
  maxDistanceMeters: 10_000,
};

async function timedLookup(body) {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-astrosight-origin-token": token,
    },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const elapsedMs = performance.now() - startedAt;
  return { response, bytes, elapsedMs };
}

function validate(result, expectedRequest = request) {
  if (result.response.status !== 200) {
    throw new Error(`precomputed lookup failed with HTTP ${result.response.status}`);
  }
  const value = JSON.parse(new TextDecoder().decode(result.bytes));
  if (
    value?.version !== 2 || value?.precomputed !== true ||
    value?.requestedBearingCount !== expectedRequest.bearings.length ||
    !Array.isArray(value.profiles) || value.profiles.length !== expectedRequest.bearings.length ||
    !Array.isArray(value.failedBearings) || value.failedBearings.length !== 0 ||
    !Number.isSafeInteger(value.pointCount) || value.pointCount <= 0
  ) throw new Error("precomputed response is invalid");
  return value;
}

const cold = await timedLookup(request);
const coldValue = validate(cold);
const warm = await timedLookup(request);
const warmValue = validate(warm);
const clientBatchStartedAt = performance.now();
let clientBatchResponseBytes = 0;
let clientBatchPointCount = 0;
let clientBatchRequestCount = 0;
for (let offset = 0; offset < request.bearings.length; offset += 32) {
  const chunkRequest = { ...request, bearings: request.bearings.slice(offset, offset + 32) };
  const chunk = await timedLookup(chunkRequest);
  const chunkValue = validate(chunk, chunkRequest);
  clientBatchResponseBytes += chunk.bytes.length;
  clientBatchPointCount += chunkValue.pointCount;
  clientBatchRequestCount += 1;
}
const clientBatchTotalMs = performance.now() - clientBatchStartedAt;
const missing = await timedLookup({
  ...request,
  subjectPoint: { ...request.subjectPoint, latitude: 35.7, longitude: 139.7, label: "未登録地点" },
});
if (missing.response.status !== 404) {
  throw new Error(`missing profile must return 404; received ${missing.response.status}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  status: "PASS",
  landmark: request.subjectPoint.label,
  bearingCount: request.bearings.length,
  maximumDistanceMeters: request.maxDistanceMeters,
  terrainPointCount: coldValue.pointCount,
  responseBytes: cold.bytes.length,
  coldRequestMs: Number(cold.elapsedMs.toFixed(1)),
  warmRequestMs: Number(warm.elapsedMs.toFixed(1)),
  warmPointCount: warmValue.pointCount,
  clientBatchRequestCount,
  clientBatchTotalMs: Number(clientBatchTotalMs.toFixed(1)),
  clientBatchResponseBytes,
  clientBatchPointCount,
  missingProfileStatus: missing.response.status,
};
const reportPath = path.join(repositoryRoot, "evidence", "precomputed-profile-origin-benchmark.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
console.log(`report: ${reportPath}`);
