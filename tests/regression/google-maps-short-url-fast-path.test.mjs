import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resolveGoogleMapsSharedUrl } from "../../server/googleMaps.ts";

const SHORT_URL = "https://maps.app.goo.gl/691Fsn21tN37m2Pb6";

function redirectTo(location) {
  return new Response(null, { status: 302, headers: { location } });
}

test("short link whose redirect names the place coordinates resolves with a single request", async () => {
  const calls = [];
  const result = await resolveGoogleMapsSharedUrl(SHORT_URL, {
    fetcher: async (input) => {
      calls.push(String(input));
      assert.equal(calls.length, 1, "転送先のGoogleマップ本体ページを取得してはならない");
      return redirectTo(
        "https://www.google.com/maps/place/%E6%9D%B1%E4%BA%AC%E3%82%BF%E3%83%AF%E3%83%BC/@35.6590,139.7430,17z/data=!3m1!4b1!4m6!3m5!1s0x60188bbd9009ec09:0x481a93f0d2a409dd!8m2!3d35.6585805!4d139.7454329"
      );
    },
  });
  assert.equal(calls.length, 1);
  // 画面中心（@）ではなく、地点の正式座標（!3d!4d）を採用する。
  assert.equal(result.latitude, 35.6585805);
  assert.equal(result.longitude, 139.7454329);
  assert.equal(result.label, "東京タワー");
  assert.equal(result.diagnostics.extractionSource, "redirect-location");
});

test("short link to a dropped pin resolves from the redirect alone", async () => {
  let calls = 0;
  const result = await resolveGoogleMapsSharedUrl(SHORT_URL, {
    fetcher: async () => {
      calls += 1;
      return redirectTo("https://www.google.com/maps/search/35.360626,+138.727363?entry=tts");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.latitude, 35.360626);
  assert.equal(result.longitude, 138.727363);
});

test("a viewport-only redirect is not short-circuited and still loads the page", async () => {
  const calls = [];
  const result = await resolveGoogleMapsSharedUrl(SHORT_URL, {
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return redirectTo("https://www.google.com/maps/place/Somewhere/@35.0000,139.0000,17z?entry=ttu");
      }
      if (url.startsWith("https://www.google.com/maps/place/Somewhere/")) {
        return new Response(
          '<html><head><meta content="https://www.google.com/maps/place/Somewhere/@35.0000,139.0000,17z/data=!3d35.0123!4d139.0456" property="og:url"></head></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return Response.json([]);
    },
  });
  // 早期確定は地点座標が明示されている場合だけ。画面中心（@）だけの転送は
  // 従来どおりページ取得まで進む（この経路の座標の選び方は今回変更していない）。
  assert.ok(calls.length >= 2, "画面中心だけでは確定せず、ページを取得する");
  assert.notEqual(result.diagnostics.extractionSource, "redirect-location");
});

test("the app waits longer than the server-side resolver budget", () => {
  const client = fs.readFileSync(new URL("../../src/search/spotPresetSearch.ts", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../../server/googleMaps.ts", import.meta.url), "utf8");
  const clientMs = Number(client.match(/GOOGLE_MAPS_RESOLVER_CLIENT_TIMEOUT_MS = ([\d_]+)/u)[1].replaceAll("_", ""));
  const serverMs = Number(server.match(/const DEFAULT_TIMEOUT_MS = ([\d_]+)/u)[1].replaceAll("_", ""));
  assert.ok(clientMs > serverMs, `client ${clientMs}ms must exceed server ${serverMs}ms`);
  assert.match(client, /"\/api\/resolve-google-maps"[\s\S]{0,400}GOOGLE_MAPS_RESOLVER_CLIENT_TIMEOUT_MS, 2\)/u);
});
