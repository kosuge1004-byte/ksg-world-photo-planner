import assert from "node:assert/strict";

import {
  resolveGoogleMapsSharedUrlNatively,
} from "../src/search/nativeGoogleMapsResolver.ts";

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

console.log(
  JSON.stringify({
    shortLinkResult,
    gifuCastleResult,
  })
);
