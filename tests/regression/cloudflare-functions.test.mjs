import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { find } from "geo-tz";
import { onRequest as finalizeSearch } from "../../functions/api/spot-search-finalize.ts";
import { onRequest as resolveGoogleMaps } from "../../functions/api/resolve-google-maps.ts";
import { onRequest as startSearch } from "../../functions/api/spot-search-start.ts";
import { onRequest as searchStatus } from "../../functions/api/spot-search-status.ts";
import { onRequest as resolveTimezone } from "../../functions/api/timezone.ts";
import { findCloudflareTimeZones } from "../../server/cloudflareGeoTz.ts";
import { googleMapsPlaceQueryCandidates } from "../../server/googleMaps.ts";

const DATA_PART_BYTES = 4 * 1024 * 1024;
const geoTzEntry = fileURLToPath(import.meta.resolve("geo-tz"));
const geoTzData = path.resolve(path.dirname(geoTzEntry), "..", "data");
const indexBytes = fs.readFileSync(
  path.join(geoTzData, "timezones-1970.geojson.index.json")
);
const boundaryBytes = fs.readFileSync(
  path.join(geoTzData, "timezones-1970.geojson.geo.dat")
);

const assets = {
  async fetch(input) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("timezones-1970.index.json")) {
      return new Response(indexBytes);
    }
    const match = url.pathname.match(/part-(\d+)\.bin$/);
    if (!match) return new Response(null, { status: 404 });
    const partIndex = Number(match[1]);
    const start = partIndex * DATA_PART_BYTES;
    return new Response(boundaryBytes.subarray(
      start,
      Math.min(boundaryBytes.length, start + DATA_PART_BYTES)
    ));
  },
};

class MemoryKv {
  values = new Map();

  async get(key, options) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

class MemoryQueue {
  messages = [];

  async send(message) {
    this.messages.push(message);
  }
}

function eventContext(request, env) {
  return {
    request,
    env,
    params: {},
    data: {},
    functionPath: new URL(request.url).pathname,
    waitUntil() {},
    passThroughOnException() {},
    next: async () => new Response(null, { status: 404 }),
  };
}

test("Cloudflare geo-tz adapter matches geo-tz boundary results", async () => {
  const samples = [
    [35.681236, 139.767125],
    [40.7128, -74.006],
    [51.5074, -0.1278],
    [-33.8688, 151.2093],
    [27.7172, 85.324],
    [21.3069, -157.8583],
    [0, -140],
  ];
  for (const [latitude, longitude] of samples) {
    const actual = await findCloudflareTimeZones(
      latitude,
      longitude,
      assets,
      "https://astrosight.example/api/timezone"
    );
    assert.deepEqual(actual, find(latitude, longitude));
  }
});

test("timezone Pages Function preserves the public response contract", async () => {
  const request = new Request(
    "https://astrosight.example/api/timezone?latitude=35.681236&longitude=139.767125"
  );
  const response = await resolveTimezone(eventContext(request, { ASSETS: assets }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { timeZone: "Asia/Tokyo" });
});

test("Google Maps Pages Function parses direct supported URLs", async () => {
  const request = new Request("https://astrosight.example/api/resolve-google-maps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://maps.google.com/?q=35.4339171,136.782051",
    }),
  });
  const response = await resolveGoogleMaps(eventContext(request, {}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    latitude: 35.4339171,
    longitude: 136.782051,
    resolvedUrl: "https://maps.google.com/?q=35.4339171,136.782051",
  });
});

test("Google Maps postal-address place URLs retain a landmark fallback", () => {
  assert.deepEqual(
    googleMapsPlaceQueryCandidates("〒500-0000 岐阜県岐阜市天主閣18番地 岐阜城"),
    [
      "〒500-0000 岐阜県岐阜市天主閣18番地 岐阜城",
      "岐阜県岐阜市天主閣18番地 岐阜城",
      "岐阜城",
    ]
  );
});

test("spot search Pages Functions preserve API status while KV stores Cloudflare metadata", async () => {
  const kv = new MemoryKv();
  const queue = new MemoryQueue();
  const env = {
    SPOT_SEARCH_JOBS: kv,
    SPOT_SEARCH_QUEUE: queue,
  };
  const clientId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  const input = {
    criteria: {},
    subject: {},
    baseDateIso: "2026-08-03T00:00:00.000Z",
    timeZone: "Asia/Tokyo",
    lensCenterHeightMeters: 1.5,
    subjectGroundHeightMeters: 0,
    calculationMode: "standard",
  };
  const startRequest = new Request("https://astrosight.example/api/spot-search-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, jobId, input }),
  });
  const startResponse = await startSearch(eventContext(startRequest, env));
  assert.equal(startResponse.status, 202);
  assert.deepEqual(await startResponse.json(), { jobId, status: "queued" });
  assert.equal(queue.messages.length, 1);

  const storedKey = [...kv.values.keys()][0];
  const stored = JSON.parse(kv.values.get(storedKey));
  assert.equal(stored.status, "queued");
  assert.equal(stored.job.status, "queued");
  assert.deepEqual(stored.request, input);
  assert.deepEqual(stored.partialResult, []);
  assert.match(stored.expiresAt, /^2026-|^202[7-9]-|^20[3-9]\d-/);

  const statusRequest = new Request(
    `https://astrosight.example/api/spot-search-status?clientId=${clientId}&jobId=${jobId}`
  );
  const statusResponse = await searchStatus(eventContext(statusRequest, env));
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status, "queued");

  const partialResult = [{ id: "server-candidate", date: "2026-08-03T00:00:00.000Z" }];
  stored.status = "running";
  stored.job.status = "awaiting-3d";
  stored.job.results = partialResult;
  stored.partialResult = partialResult;
  kv.values.set(storedKey, JSON.stringify(stored));

  const finalizeRequest = new Request("https://astrosight.example/api/spot-search-finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, jobId, results: [] }),
  });
  const finalizeResponse = await finalizeSearch(eventContext(finalizeRequest, env));
  assert.equal(finalizeResponse.status, 200);
  assert.equal((await finalizeResponse.json()).status, "complete");
  const finalized = JSON.parse(kv.values.get(storedKey));
  assert.equal(finalized.status, "completed");
  assert.deepEqual(finalized.partialResult, partialResult);
  assert.deepEqual(finalized.finalResult, []);
});
