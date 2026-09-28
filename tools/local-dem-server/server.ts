import { createServer } from "node:http";
import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
import { lookupLocalDemElevationsForSource } from "../../server/gsiLocalDem.ts";
import { createLocalDemRequestHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createReadOnlyDemCache } from "./readOnlyDemCache.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const persistentCache = await createReadOnlyDemCache(config.dataRoot);
  await persistentCache.validateReady();
  configureServerRuntime({ persistentCache });

  const handler = createLocalDemRequestHandler(
    config,
    lookupLocalDemElevationsForSource
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
