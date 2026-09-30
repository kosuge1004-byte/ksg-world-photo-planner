import assert from "node:assert/strict";
import test from "node:test";

import {
  findRegisteredLandmarkForLocation,
  snapSpotLocationToRegisteredLandmark,
} from "../../src/search/spotPresetSearch.ts";
import { fetchBearingProfileBatchDetailed } from "../../src/cache/bearingProfileBatchClient.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_TARGETS,
  findPrecomputedBearingProfileTarget,
} from "../../src/data/precomputedBearingProfileTargets.ts";
import { apiEndpoint } from "../../src/network/apiEndpoint.ts";

const SKYTREE = { latitude: 35.7100627, longitude: 139.8107004 };

test("address-search label for a registered spot snaps to the registered coordinates", () => {
  const nominatim = {
    latitude: 35.7101069,
    longitude: 139.8108103,
    label: "東京スカイツリー, 2, 押上一丁目, 押上, 墨田区, 東京都, 131-0045, 日本",
  };
  const snapped = snapSpotLocationToRegisteredLandmark(nominatim);
  assert.equal(snapped.latitude, SKYTREE.latitude);
  assert.equal(snapped.longitude, SKYTREE.longitude);
  assert.equal(snapped.label, "東京スカイツリー");
  assert.equal(snapped.subjectSurfaceTarget, "structure-roof");
  assert.equal(snapped.structureHeightMeters, 634);
});

test("unrelated names or distant points are never moved", () => {
  const nearbyOther = { latitude: 35.7102, longitude: 139.8109, label: "押上駅, 墨田区, 東京都, 日本" };
  assert.equal(snapSpotLocationToRegisteredLandmark(nearbyOther), nearbyOther);
  const farSameName = { latitude: 35.73, longitude: 139.8107004, label: "東京スカイツリー" };
  assert.equal(findRegisteredLandmarkForLocation(farSameName), null);
  assert.equal(snapSpotLocationToRegisteredLandmark(farSameName), farSameName);
});

test("exact registered location is returned unchanged", () => {
  const exact = { ...SKYTREE, label: "東京スカイツリー", subjectSurfaceTarget: "structure-roof", structureHeightMeters: 634 };
  assert.equal(snapSpotLocationToRegisteredLandmark(exact), exact);
});

test("precomputed targets include every non-mountain landmark and Steel Dragon 2000", () => {
  assert.equal(PRECOMPUTED_BEARING_PROFILE_TARGETS.length, 201);
  assert.equal(
    findPrecomputedBearingProfileTarget(35.0326866, 136.7332893)?.name,
    "スチールドラゴン2000"
  );
});

test("Capacitor API requests use Cloudflare instead of the bundled index.html origin", () => {
  assert.equal(
    apiEndpoint("/api/bearing-profile-batch", true),
    "https://astrosight.pages.dev/api/bearing-profile-batch"
  );
  assert.equal(apiEndpoint("/api/bearing-profile-batch", false), "/api/bearing-profile-batch");
});

const batchRequest = {
  subjectPoint: { latitude: 35.7101069, longitude: 139.8108103, height: 0 },
  cameraSettings: { lensCenterHeightMeters: 1.6 },
  bearings: [0, 1],
  maxDistanceMeters: 10_000,
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("batch miss reasons are reported instead of collapsing to null", async () => {
  const notFound = await fetchBearingProfileBatchDetailed(batchRequest, undefined, async () =>
    jsonResponse(404, { code: "PRECOMPUTED_PROFILE_NOT_FOUND", error: "x" }));
  assert.equal(notFound.ok, false);
  assert.equal(notFound.miss.notPrecomputed, true);
  assert.match(notFound.miss.reason, /計算済み地形データがありません/);

  const wideRange = await fetchBearingProfileBatchDetailed({ ...batchRequest, maxDistanceMeters: 20_000 }, undefined, async () =>
    jsonResponse(404, { code: "PRECOMPUTED_PROFILE_NOT_FOUND", error: "x" }));
  assert.match(wideRange.miss.reason, /10kmのみ/);

  const tooMany = await fetchBearingProfileBatchDetailed(batchRequest, undefined, async () =>
    jsonResponse(422, { error: "Too many subrequests" }));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.miss.notPrecomputed, false);
  assert.match(tooMany.miss.reason, /HTTP 422.*Too many subrequests/);

  const network = await fetchBearingProfileBatchDetailed(batchRequest, undefined, async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.match(network.miss.reason, /接続できませんでした/);

  const html = await fetchBearingProfileBatchDetailed(batchRequest, undefined, async () =>
    new Response("<!doctype html><title>AstroSight</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
  assert.equal(html.ok, false);
  assert.match(html.miss.reason, /応答形式が不正/);
});

// 2026-09-30: 契約変更。登録スポットのR2未配置も、理由付きのmissとして返し、
// ダウンロードは1方位経路で続行する（例外で終わらせない）。
test("registered-spot R2 unavailability is surfaced as a reasoned miss", async () => {
  const outcome = await fetchBearingProfileBatchDetailed(batchRequest, undefined, async () =>
    jsonResponse(503, { code: "PRECOMPUTED_PROFILE_UNAVAILABLE", error: "R2未配置" }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.miss.reason, "R2未配置");
});
