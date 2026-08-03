import assert from "node:assert/strict";
import test from "node:test";

import { fetchGsiElevationSamples } from "../../src/cesium/gsiElevationClient.ts";

function points(count) {
  return Array.from({ length: count }, (_, index) => ({
    latitude: 35 + index * 0.0001,
    longitude: 136 + index * 0.0001,
    maximumDetail: "1m",
  }));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

test("large DEM requests split until Cloudflare can complete them", async () => {
  const requestSizes = [];
  const fetcher = async (_url, init) => {
    const requested = JSON.parse(init.body).points;
    requestSizes.push(requested.length);
    if (requested.length > 8) {
      return jsonResponse({ error: "upstream timeout" }, 524);
    }
    return jsonResponse({
      samples: requested.map((_point, index) => ({
        heightMeters: 100 + index,
        source: "DEM5A",
      })),
    });
  };

  const result = await fetchGsiElevationSamples(points(40), undefined, fetcher);

  assert.equal(result.samples.length, 40);
  assert.equal(result.failedPointCount, 0);
  assert.ok(result.samples.every((sample) => sample.source === "DEM5A"));
  assert.ok(requestSizes.includes(32));
  assert.ok(requestSizes.includes(16));
  assert.ok(requestSizes.includes(8));
  assert.ok(Math.max(...requestSizes) <= 32);
});

test("unrecoverable DEM subsets fall back without discarding other points", async () => {
  const fetcher = async (_url, init) => {
    const requested = JSON.parse(init.body).points;
    if (requested.some((point) => point.latitude < 35.0008)) {
      return new Response("gateway failure", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }
    return jsonResponse({
      samples: requested.map(() => ({ heightMeters: 50, source: "DEM10B" })),
    });
  };

  const result = await fetchGsiElevationSamples(points(16), undefined, fetcher);

  assert.equal(result.samples.length, 16);
  assert.equal(result.failedPointCount, 8);
  assert.equal(result.samples.slice(0, 8).every((sample) => sample.source === null), true);
  assert.equal(result.samples.slice(8).every((sample) => sample.source === "DEM10B"), true);
});

test("DEM requests preserve user cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchGsiElevationSamples(points(1), controller.signal, async () => {
      throw new Error("fetch should not run");
    }),
    (error) => error instanceof DOMException && error.name === "AbortError"
  );
});
