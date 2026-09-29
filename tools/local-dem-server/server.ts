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

async function main(): Promise<void> {
  const config = loadConfig();
  configureLocalDemMemoryBudgetForPrivateOrigin(512 * 1024 * 1024);
  const persistentCache = await createLocalDemPersistentCache(config.dataRoot);
  await persistentCache.validateReady();
  const precomputedProfiles = await createReadOnlyBearingProfileStore(config.dataRoot);
  configureServerRuntime({ persistentCache });

  const handler = createLocalDemRequestHandler(
    config,
    lookupLocalDemElevationsForSource,
    (points, signal) => lookupGsiElevations(points, signal),
    precomputedProfiles
      ? (request) => precomputedProfiles.lookup(request)
      : undefined,
    (request, signal) => computeBearingProfileBatch(request, signal, {
      // The precomputed route is tried before this exact on-demand route.
      // Keeping this calculation independent prevents a second file lookup and
      // guarantees that the requested coordinates, including metre-scale
      // offsets from catalogue points, are sampled as supplied.
      lookupPrecomputed: async () => null,
      lookupElevations: (points, requestSignal) =>
        lookupGsiElevations(points, requestSignal, undefined, { useLocalGateway: false }),
      lookupGeoidHeights: lookupBearingProfileGeoidHeights,
      nowIso: () => new Date().toISOString(),
    })
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
    }));
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
