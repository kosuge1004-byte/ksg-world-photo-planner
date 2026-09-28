import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { lookupLocalDemElevationsForSource } from "../server/gsiLocalDem.ts";
import { createLocalDemRequestHandler } from "../tools/local-dem-server/app.ts";
import { createReadOnlyDemCache } from "../tools/local-dem-server/readOnlyDemCache.ts";

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const assetRoot = path.resolve(option(
  "asset-root",
  "E:/AstroSight-GSI-data-20260926/dem/r2-ready",
));
const outputPath = path.resolve(option(
  "output",
  "evidence/local-dem-server-five-site-audit-20260928.json",
));
const sites = [
  { name: "Tokyo", latitude: 35.681236, longitude: 139.767125 },
  { name: "Osaka", latitude: 34.702485, longitude: 135.495951 },
  { name: "Sapporo", latitude: 43.068661, longitude: 141.350755 },
  { name: "Fukuoka", latitude: 33.590355, longitude: 130.401716 },
  { name: "Naha", latitude: 26.212401, longitude: 127.680932 },
];
const sources = ["DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B"];

const persistentCache = await createReadOnlyDemCache(assetRoot);
await persistentCache.validateReady();
configureServerRuntime({ persistentCache });

const originToken = randomBytes(32).toString("hex");
const config = {
  host: "127.0.0.1",
  port: 0,
  dataRoot: assetRoot,
  originToken,
  maximumBodyBytes: 131_072,
  maximumPoints: 512,
  requestTimeoutMs: 5_000,
  maximumConcurrentRequests: 2,
  maximumQueuedRequests: 8,
};
const handler = createLocalDemRequestHandler(config, lookupLocalDemElevationsForSource);
const server = createServer((request, response) => void handler(request, response));

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const results = sites.map((site, index) => ({ ...site, index, source: null, heightMeters: null }));
  for (const source of sources) {
    const pending = results.filter((result) => result.heightMeters === null);
    if (pending.length === 0) break;
    const response = await fetch(`${baseUrl}/v1/elevation/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-astrosight-origin-token": originToken,
      },
      body: JSON.stringify({
        source,
        points: pending.map((point) => ({
          index: point.index,
          latitude: point.latitude,
          longitude: point.longitude,
          interpolation: "constrained-bicubic",
          interpolationMode: "neutral",
        })),
      }),
    });
    assert.equal(response.status, 200, `${source} HTTP status`);
    const payload = await response.json();
    assert.equal(payload.source, source);
    assert.equal(payload.results.length, pending.length);
    for (const sample of payload.results) {
      const result = results[sample.index];
      assert.ok(result && result.heightMeters === null);
      if (sample.heightMeters !== null) {
        assert.ok(Number.isFinite(sample.heightMeters));
        result.heightMeters = sample.heightMeters;
        result.source = source;
      }
    }
  }

  for (const result of results) {
    assert.ok(Number.isFinite(result.heightMeters), `${result.name} must resolve from local data`);
    const direct = await lookupLocalDemElevationsForSource(result.source, [{
      index: result.index,
      latitude: result.latitude,
      longitude: result.longitude,
      interpolation: "constrained-bicubic",
      interpolationMode: "neutral",
    }]);
    assert.equal(direct.get(result.index), result.heightMeters, `${result.name} HTTP/direct mismatch`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    service: "loopback authenticated read-only local DEM API",
    health: { ok: true },
    siteCount: results.length,
    allResolvedLocally: true,
    maximumHttpVsDirectDifferenceMeters: 0,
    points: results.map(({ index: _index, ...result }) => result),
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  configureServerRuntime({});
}
