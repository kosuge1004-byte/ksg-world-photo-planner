import { createServer } from "node:http";
import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
import { lookupGsiElevations } from "../../server/gsiElevation.ts";
import {
  computeBearingProfileBatch,
  lookupBearingProfileGeoidHeights,
} from "../../server/bearingProfileBatch.ts";
import {
  configureLocalDemMemoryBudgetForPrivateOrigin,
  lookupLocalDemElevationsForSource,
} from "../../server/gsiLocalDem.ts";
import { createLocalDemRequestHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createReadOnlyBearingProfileStore } from "./readOnlyBearingProfileStore.ts";
import { createLocalDemPersistentCache } from "./localDemPersistentCache.ts";
import { createDynamicSpotStore } from "./dynamicSpotStore.ts";
import { createPlateauBuildingStore } from "./plateauBuildingStore.ts";
import { createSpotCandidateListWriter, type SpotCandidateListWriter } from "./spotCandidateList.ts";
import { createPendingSpotPuller } from "./pendingSpotPuller.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLocalDemMemoryBudgetForPrivateOrigin(512 * 1024 * 1024);
  const persistentCache = await createLocalDemPersistentCache(config.dataRoot);
  const demReadiness = await persistentCache.validateReady();
  const precomputedProfiles = await createReadOnlyBearingProfileStore(config.dataRoot);
  configureServerRuntime({ persistentCache });

  const computeExactProfile = (request: Parameters<typeof computeBearingProfileBatch>[0], signal: AbortSignal) =>
    computeBearingProfileBatch(request, signal, {
      // Static and dynamic stored profiles are checked before this callback.
      // Exact generation always uses the requested coordinate itself.
      lookupPrecomputed: async () => null,
      lookupElevations: (points, requestSignal) =>
        lookupGsiElevations(points, requestSignal, undefined, { useLocalGateway: false }),
      lookupGeoidHeights: lookupBearingProfileGeoidHeights,
      nowIso: () => new Date().toISOString(),
    });
  // 2026-10-16: 自動登録スポットが保存されるたびに、その月の「登録スポット候補」
  // 一覧（登録スポット候補\登録スポットYYYYMM一覧.txt）を作り直す。
  let candidateLists: SpotCandidateListWriter | null = null;
  const dynamicSpots = await createDynamicSpotStore(config.dataRoot, computeExactProfile, {
    onRecordPersisted: (changed, records) => candidateLists?.writeMonthOf(changed, records),
  });
  candidateLists = createSpotCandidateListWriter(dynamicSpots.root);
  // 起動時に全月分を作り直す（今ある自動登録スポットも月ごとの一覧になる）。
  await candidateLists.writeAll(dynamicSpots.listRecords()).catch(() => {
    console.error(JSON.stringify({ event: "spot-candidate-list-write-failed" }));
  });
  // 2026-10-16: データサービスにつながらなかった間にCloudflareへ貯められた登録を受け取る。
  const pendingSpots = createPendingSpotPuller({
    registrationToken: process.env.LOCAL_DEM_REGISTRATION_TOKEN,
    registerUrl: process.env.ASTROSIGHT_LOCAL_DEM_REGISTER_URL,
    register: (input) => dynamicSpots.register(input),
  });
  // Building data is an optional acceleration path. A missing or damaged
  // building index must never prevent the established DEM/profile service
  // from starting; the browser then uses its existing PLATEAU fallback.
  const plateauBuildings = await createPlateauBuildingStore(config.dataRoot).catch(() => null);

  const handler = createLocalDemRequestHandler(
    config,
    lookupLocalDemElevationsForSource,
    (points, signal) => lookupGsiElevations(points, signal),
    precomputedProfiles
      ? (request) => precomputedProfiles.lookup(request)
      : undefined,
    computeExactProfile,
    dynamicSpots,
    {
      nationwideDemReady: demReadiness.nationwideReady,
      plateauRoofLookup: plateauBuildings
        ? (latitude, longitude) => plateauBuildings.lookup(latitude, longitude)
        : undefined,
    }
  );
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.headersTimeout = Math.min(config.requestTimeoutMs, 5_000);
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;
  server.listen(config.port, config.host, () => {
    console.info(JSON.stringify({
      event: "local-dem-listening",
      host: "loopback",
      port: config.port,
      precomputedProfiles: precomputedProfiles?.entryCount ?? 0,
      dynamicSpotStore: true,
      plateauBuildingEntries: plateauBuildings?.entryCount ?? 0,
      nationwideDemReady: demReadiness.nationwideReady,
    }));
    dynamicSpots.resumeIncomplete();
    pendingSpots.start();
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "local-dem-stopping" }));
    server.close(() => process.exit(0));
    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 5_000);
    forceTimer.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  // Startup errors stay generic so logs cannot disclose a data path or secret.
  console.error(JSON.stringify({ event: "local-dem-start-failed" }));
  process.exitCode = 1;
});
