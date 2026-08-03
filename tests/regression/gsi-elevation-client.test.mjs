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
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const fetcher = async (_url, init) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const requested = JSON.parse(init.body).points;
    requestSizes.push(requested.length);
    activeRequests -= 1;
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
  assert.ok(maximumActiveRequests <= 2);
});

test("an unrecoverable DEM point does not discard its neighboring points", async () => {
  const fetcher = async (_url, init) => {
    const requested = JSON.parse(init.body).points;
    if (requested.some((point) => point.latitude === 35)) {
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
  assert.equal(result.failedPointCount, 1);
  assert.equal(result.samples[0].source, null);
  assert.equal(result.samples.slice(1).every((sample) => sample.source === "DEM10B"), true);
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
