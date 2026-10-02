import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { computeBearingProfileBatch, lookupBearingProfileGeoidHeights } from "../server/bearingProfileBatch.ts";
import { lookupGsiElevations } from "../server/gsiElevation.ts";
import { configureLocalDemMemoryBudgetForPrivateOrigin } from "../server/gsiLocalDem.ts";
import { createLocalDemPersistentCache } from "../tools/local-dem-server/localDemPersistentCache.ts";
import { createDynamicSpotStore } from "../tools/local-dem-server/dynamicSpotStore.ts";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const dataRoot = path.resolve(process.env.LOCAL_DEM_DATA_ROOT ||
  "E:\\AstroSight-GSI-data-20260926\\dem\\r2-ready");
const evidencePath = path.join(repositoryRoot, "evidence", "dynamic-spots-benchmark-latest.json");
const allBearings = Array.from({ length: 360 }, (_, bearing) => bearing);

async function directoryBytes(root) {
  let total = 0;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

async function waitForComplete(store, input, timeoutMs = 30 * 60_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const record = store.lookupByCoordinate(input.latitude, input.longitude);
    if (record?.demProfileStatus === "complete") return record;
    if (record?.currentStage === "failed") {
      throw new Error(record.lastError || `${input.name} failed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${input.name} timed out`);
}

const persistentCache = await createLocalDemPersistentCache(dataRoot);
await persistentCache.validateReady();
configureLocalDemMemoryBudgetForPrivateOrigin(1024 * 1_048_576);
configureServerRuntime({ persistentCache });
const compute = (request, signal) => computeBearingProfileBatch(request, signal, {
  lookupPrecomputed: async () => null,
  lookupElevations: (points, requestSignal) =>
    lookupGsiElevations(points, requestSignal, undefined, { useLocalGateway: false }),
  lookupGeoidHeights: lookupBearingProfileGeoidHeights,
  nowIso: () => new Date().toISOString(),
});
const store = await createDynamicSpotStore(dataRoot, compute);

const cases = [
  {
    id: "terrain-dem-cached",
    warmFirst: true,
    input: {
      name: "Dynamic benchmark terrain cached",
      aliases: ["dynamic-benchmark-terrain-cached"],
      latitude: 35.00512345,
      longitude: 136.00512345,
      category: "benchmark/terrain",
      subjectSurface: "terrain",
      structureHeightMeters: 0,
      heightSourceType: "unknown",
      heightSourceUrl: null,
      heightSourceLabel: null,
      heightStatus: "unknown",
      maxDistanceMeters: 10_000,
      bearingCount: 360,
    },
  },
  {
    id: "terrain-dem-not-cached",
    warmFirst: false,
    input: {
      name: "Dynamic benchmark terrain uncached",
      aliases: ["dynamic-benchmark-terrain-uncached"],
      latitude: 43.22345678,
      longitude: 142.88765432,
      category: "benchmark/terrain",
      subjectSurface: "terrain",
      structureHeightMeters: 0,
      heightSourceType: "unknown",
      heightSourceUrl: null,
      heightSourceLabel: null,
      heightStatus: "unknown",
      maxDistanceMeters: 10_000,
      bearingCount: 360,
    },
  },
  {
    id: "structure-plateau",
    warmFirst: false,
    input: {
      name: "Dynamic benchmark PLATEAU structure",
      aliases: ["dynamic-benchmark-plateau"],
      latitude: 34.70011111,
      longitude: 135.50022222,
      category: "benchmark/structure",
      subjectSurface: "structure",
      structureHeightMeters: 45.25,
      heightSourceType: "plateau-measured",
      heightSourceUrl: "https://www.mlit.go.jp/plateau/",
      heightSourceLabel: "benchmark pre-resolved PLATEAU measurement",
      heightStatus: "measured",
      maxDistanceMeters: 10_000,
      bearingCount: 360,
    },
  },
  {
    id: "structure-osm-fallback",
    warmFirst: false,
    input: {
      name: "Dynamic benchmark OSM structure",
      aliases: ["dynamic-benchmark-osm"],
      latitude: 33.59012345,
      longitude: 130.40123456,
      category: "benchmark/structure",
      subjectSurface: "structure",
      structureHeightMeters: 30,
      heightSourceType: "osm-height",
      heightSourceUrl: "https://www.openstreetmap.org/",
      heightSourceLabel: "benchmark pre-resolved OSM height",
      heightStatus: "estimated",
      maxDistanceMeters: 10_000,
      bearingCount: 360,
    },
  },
];

const originalFetch = globalThis.fetch;
let activeRequests = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const started = performance.now();
  try {
    const response = await originalFetch(input, init);
    activeRequests.push({ host: new URL(url).host, status: response.status, elapsedMs: performance.now() - started });
    return response;
  } catch (error) {
    activeRequests.push({ host: new URL(url).host, status: null, elapsedMs: performance.now() - started });
    throw error;
  }
};

const results = [];
try {
  for (const entry of cases) {
    if (store.lookupByCoordinate(entry.input.latitude, entry.input.longitude)?.demProfileStatus === "complete") {
      results.push({ id: entry.id, skipped: true, reason: "already complete from an earlier measured run" });
      continue;
    }
    if (entry.warmFirst) {
      await compute({
        subjectPoint: { latitude: entry.input.latitude, longitude: entry.input.longitude, height: 0, label: entry.input.name },
        cameraSettings: { lensCenterHeightMeters: 1.6 },
        bearings: allBearings,
        maxDistanceMeters: 10_000,
      }, new AbortController().signal);
    }
    const dynamicBytesBefore = await directoryBytes(store.root);
    const decodedRoot = path.join(dataRoot, "gsi-decoded-dem-v2");
    const decodedBytesBefore = await directoryBytes(decodedRoot);
    activeRequests = [];
    const acceptedStarted = performance.now();
    await store.register(entry.input);
    const registrationAcceptedMs = performance.now() - acceptedStarted;
    const generationStarted = performance.now();
    const complete = await waitForComplete(store, entry.input);
    const generationMs = performance.now() - generationStarted;
    const dynamicBytesAfter = await directoryBytes(store.root);
    const decodedBytesAfter = await directoryBytes(decodedRoot);
    const firstRunRequests = activeRequests;

    activeRequests = [];
    const secondStarted = performance.now();
    await store.register(entry.input);
    const response = await store.lookupProfile({
      subjectPoint: { latitude: entry.input.latitude, longitude: entry.input.longitude, height: 0, label: entry.input.name },
      cameraSettings: { lensCenterHeightMeters: 1.6 },
      bearings: allBearings,
      maxDistanceMeters: 10_000,
    });
    const secondUseMs = performance.now() - secondStarted;
    if (!response || response.profiles.length !== 360) throw new Error(`${entry.id} second-use profile validation failed`);
    results.push({
      id: entry.id,
      coordinate: { latitude: entry.input.latitude, longitude: entry.input.longitude },
      heightSourceType: entry.input.heightSourceType,
      heightResolutionMode: entry.input.subjectSurface === "structure" ? "pre-resolved-input" : "terrain",
      searchStartToSubjectDisplayMs: null,
      searchStartToSubjectDisplayReason: "local Node benchmark has no browser/Cesium render surface",
      registrationAcceptedMs,
      generation360Ms: generationMs,
      generatedProfileBytes: complete.profileBytes,
      dynamicStoreNewBytes: dynamicBytesAfter - dynamicBytesBefore,
      decodedDemNewBytes: decodedBytesAfter - decodedBytesBefore,
      externalRequestCount: firstRunRequests.length,
      externalRequestsByHost: Object.fromEntries(Array.from(new Set(firstRunRequests.map((request) => request.host)))
        .map((host) => [host, firstRunRequests.filter((request) => request.host === host).length])),
      secondUseMs,
      secondUseExternalRequestCount: activeRequests.length,
      completedBearings: complete.completedBearings,
      profilePointCount: response.pointCount,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  globalThis.fetch = originalFetch;
}

const report = {
  measuredAt: new Date().toISOString(),
  dataRoot,
  note: "Measured values only. Browser subject-render time is explicitly null because this script does not render Cesium.",
  cases: results,
};
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ evidencePath, caseCount: results.length }));
