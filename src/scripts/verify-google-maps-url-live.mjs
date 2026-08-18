import assert from "node:assert/strict";

import { onRequest as resolveGoogleMapsApi } from "../functions/api/resolve-google-maps.ts";
import {
  resolveGoogleMapsSharedUrlNatively,
} from "../src/search/nativeGoogleMapsResolver.ts";
import { resolveGoogleMapsSharedUrl } from "../server/googleMaps.ts";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
};

async function fetchAdapter(url, disableRedirects) {
  const response = await fetch(url, {
    headers,
    redirect: disableRedirects ? "manual" : "follow",
  });
  return {
    data: await response.text(),
    headers: Object.fromEntries(response.headers),
    status: response.status,
    url: response.url,
  };
}

const shortLinkResult = await resolveGoogleMapsSharedUrlNatively(
  "https://maps.app.goo.gl/7Xtp3LoZpuDc5Rqe7",
  undefined,
  fetchAdapter
);
assert.ok(Number.isFinite(shortLinkResult.latitude));
assert.ok(Number.isFinite(shortLinkResult.longitude));
assert.match(shortLinkResult.resolvedUrl, /google\.(?:com|co\.jp)\/maps/u);

const gifuCastleResult = await resolveGoogleMapsSharedUrlNatively(
  "https://www.google.com/maps/search/?api=1&query=%E5%B2%90%E9%98%9C%E5%9F%8E",
  undefined,
  fetchAdapter
);
assert.ok(Math.abs(gifuCastleResult.latitude - 35.4339171) < 0.001);
assert.ok(Math.abs(gifuCastleResult.longitude - 136.782051) < 0.001);

const postalAddressShortLinkResult = await resolveGoogleMapsSharedUrl(
  "https://maps.app.goo.gl/by9q32wUuTdT3AVN8?g_st=ac"
);
assert.ok(Math.abs(postalAddressShortLinkResult.latitude - 35.4339171) < 0.001);
assert.ok(Math.abs(postalAddressShortLinkResult.longitude - 136.782051) < 0.001);
assert.equal(
  postalAddressShortLinkResult.place.placeId,
  "0x6003a9798f2e0eab:0x2871c3655542c94a"
);
assert.equal(postalAddressShortLinkResult.place.placeIdType, "maps-feature-id");
assert.equal(postalAddressShortLinkResult.place.name, "岐阜城");

const apiRequest = new Request(
  "https://astrosight.example/api/resolve-google-maps",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://maps.app.goo.gl/by9q32wUuTdT3AVN8?g_st=ac",
    }),
  }
);
const apiResponse = await resolveGoogleMapsApi({
  request: apiRequest,
  env: {},
  params: {},
  data: {},
  functionPath: "/api/resolve-google-maps",
  waitUntil() {},
  passThroughOnException() {},
  next: async () => new Response(null, { status: 404 }),
});
assert.equal(apiResponse.status, 200);
assert.match(apiResponse.headers.get("content-type") ?? "", /application\/json/iu);
const apiResult = await apiResponse.json();
assert.ok(Math.abs(apiResult.latitude - 35.4339171) < 0.001);
assert.ok(Math.abs(apiResult.longitude - 136.782051) < 0.001);
assert.equal(apiResult.place.placeIdType, "maps-feature-id");
assert.equal(apiResult.place.name, "岐阜城");
assert.equal(typeof apiResult.diagnostics.requestId, "string");

console.log(
  JSON.stringify({
    shortLinkResult,
    gifuCastleResult,
    postalAddressShortLinkResult,
    api: {
      status: apiResponse.status,
      contentType: apiResponse.headers.get("content-type"),
      result: apiResult,
    },
  })
);
