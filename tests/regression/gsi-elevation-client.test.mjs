import assert from "node:assert/strict";
import test from "node:test";

import { fetchGsiElevationSamples } from "../../src/cesium/gsiElevationClient.ts";
import { isAbortError } from "../../src/utils/runtimeErrors.ts";

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

  const result = await fetchGsiElevationSamples(points(100), undefined, fetcher);

  assert.equal(result.samples.length, 100);
  assert.equal(result.failedPointCount, 0);
  assert.ok(result.samples.every((sample) => sample.source === "DEM5A"));
  // 100点は1リクエストあたり最大64点でまず2つ（64点・36点）に分割され、
  // サーバーが8点超を拒否するため、8点以下に収まるまで再帰的に半分へ分割し続ける。
  assert.ok(requestSizes.includes(64));
  assert.ok(requestSizes.includes(32));
  assert.ok(requestSizes.includes(16));
  assert.ok(requestSizes.includes(8));
  assert.ok(Math.max(...requestSizes) <= 64);
  assert.ok(maximumActiveRequests <= 16);
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

  // 2026-08-27追記: 以前は「失敗したら1点単位まで無限に分割して再送する」
  // 設計だったため、失敗する点(緯度35)だけが隔離され、周辺は正常に
  // 取得できていた。しかしこれが実機で「64点のバッチが最悪1点単位まで
  // 分裂し、497件のリクエストに膨れ上がる」輻輳の悪化を引き起こしたため、
  // 「MIN_RECOVERY_SPLIT_SIZE(8点)より細かくは分割しない」という安全策に
  // 変更した（gsiElevationClient.tsのコメント参照）。そのため、失敗する
  // 点を含む最小8点のバッチは、その8点全体が失敗扱いになる
  // （1点だけが隔離されるわけではない）。
  assert.equal(result.samples.length, 16);
  assert.equal(result.failedPointCount, 8, "8点floorにより、失敗点を含む8点のバッチ全体が失敗扱いになる");
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
    (error) => isAbortError(error)
  );
});
