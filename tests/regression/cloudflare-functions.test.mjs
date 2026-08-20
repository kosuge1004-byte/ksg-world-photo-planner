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
import { resolveJapanesePlaceName } from "../../server/placeGeocode.ts";
import {
  GoogleMapsResolutionError,
  googleMapsPlaceQueryCandidates,
  resolveGoogleMapsSharedUrl,
} from "../../server/googleMaps.ts";

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
  putCount = 0;

  async get(key, options) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.putCount += 1;
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
  // レスポンスにはR2キャッシュの状態(hit/bypass等)を示す診断用フィールド`cache`が
  // 他のPages Functions(osm-site-context, geocode, gsi-geoid, gsi-elevation)と
  // 同様に含まれる。timeZoneフィールドの内容自体は変わっていない。
  assert.deepEqual(await response.json(), { timeZone: "Asia/Tokyo", cache: "bypass" });
});

test("place geocoder uses the best GSI candidate when Nominatim returns no results", async () => {
  const calls = [];
  const result = await resolveJapanesePlaceName("東京駅", undefined, async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://nominatim.openstreetmap.org/")) {
      return Response.json([]);
    }
    assert.match(url, /^https:\/\/msearch\.gsi\.go\.jp\/address-search\/AddressSearch\?/u);
    return Response.json([
      {
        geometry: { type: "Point", coordinates: [139.6917, 35.6895] },
        properties: { title: "東京都" },
      },
      {
        geometry: { type: "Point", coordinates: [139.767125, 35.681236] },
        properties: { title: "東京駅" },
      },
    ]);
  });

  assert.deepEqual(result, {
    latitude: 35.681236,
    longitude: 139.767125,
    label: "東京駅",
  });
  assert.equal(calls.length, 2);
});

test("place geocoder keeps Nominatim as the primary provider", async () => {
  let callCount = 0;
  const result = await resolveJapanesePlaceName("東京駅", undefined, async () => {
    callCount += 1;
    return Response.json([{
      lat: "35.681236",
      lon: "139.767125",
      display_name: "東京駅, 千代田区, 東京都",
    }]);
  });

  assert.equal(result.label, "東京駅, 千代田区, 東京都");
  assert.equal(callCount, 1);
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
  const body = await response.json();
  assert.equal(body.latitude, 35.4339171);
  assert.equal(body.longitude, 136.782051);
  assert.equal(
    body.resolvedUrl,
    "https://maps.google.com/?q=35.4339171,136.782051"
  );
  assert.equal(body.place.placeId, null);
  assert.equal(body.diagnostics.extractionSource, "input-url");
  assert.equal(typeof body.diagnostics.requestId, "string");
});

test("Google Maps resolver follows the full redirect and rejects viewport coordinates", async () => {
  const shortUrl = "https://maps.app.goo.gl/currentHtmlFixture";
  const finalUrl =
    "https://www.google.com/maps/place/%E5%B2%90%E9%98%9C%E5%9F%8E/" +
    "data=!4m5!3m4!1s0x6003a9798f2e0eab:0x2871c3655542c94a!8m2!3d35.4339171!4d136.782051";
  const html = `
    <meta content="https://maps.google.com/maps/api/staticmap?center=35.241984%2C136.8358912" itemprop="image">
    <meta content="岐阜県岐阜市天主閣18番地" itemprop="address">
    <script>window.APP_INITIALIZATION_STATE=[[[26068.5,136.8358912,35.241984]]]</script>
  `;
  const calls = [];
  const result = await resolveGoogleMapsSharedUrl(shortUrl, {
    requestId: "resolver-test",
    fetcher: async (url, init) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      if (String(url) === shortUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: finalUrl },
        });
      }
      assert.equal(String(url), finalUrl);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    },
  });

  assert.equal(result.latitude, 35.4339171);
  assert.equal(result.longitude, 136.782051);
  assert.equal(result.place.placeId, "0x6003a9798f2e0eab:0x2871c3655542c94a");
  assert.equal(result.place.placeIdType, "maps-feature-id");
  assert.equal(result.place.name, "岐阜城");
  assert.equal(result.place.formattedAddress, "岐阜県岐阜市天主閣18番地");
  assert.equal(result.diagnostics.redirectCount, 1);
  assert.equal(result.diagnostics.extractionSource, "final-url");
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
});

test("Google Maps resolver enriches a Maps Feature ID with a Places API Place ID", async () => {
  const shortUrl = "https://maps.app.goo.gl/placesApiFixture";
  const finalUrl =
    "https://www.google.com/maps/place/%E5%B2%90%E9%98%9C%E5%9F%8E/" +
    "data=!4m2!3m1!1s0x6003a9798f2e0eab:0x2871c3655542c94a";
  const result = await resolveGoogleMapsSharedUrl(shortUrl, {
    requestId: "places-api-test",
    googleMapsApiKey: "test-api-key",
    fetcher: async (url, init) => {
      const value = String(url);
      if (value === shortUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: finalUrl },
        });
      }
      if (value === finalUrl) {
        return new Response("<html><title>Google Maps</title></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      assert.equal(value, "https://places.googleapis.com/v1/places:searchText");
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers["X-Goog-Api-Key"], "test-api-key");
      return Response.json({
        places: [{
          id: "ChIJGifuCastleExample",
          displayName: { text: "岐阜城", languageCode: "ja" },
          formattedAddress: "岐阜県岐阜市金華山天守閣18",
          location: { latitude: 35.4339171, longitude: 136.782051 },
        }],
      });
    },
  });

  assert.equal(result.latitude, 35.4339171);
  assert.equal(result.longitude, 136.782051);
  assert.equal(result.place.placeId, "ChIJGifuCastleExample");
  assert.equal(result.place.placeIdType, "places-api");
  assert.equal(
    result.place.googleMapsFeatureId,
    "0x6003a9798f2e0eab:0x2871c3655542c94a"
  );
  assert.equal(result.diagnostics.extractionSource, "google-places-api");
});

test("Google Maps resolver resolves registered places without an API key", async () => {
  const shortUrl = "https://maps.app.goo.gl/registeredPlaceFixture";
  const finalUrl =
    "https://www.google.com/maps/place/Registered+Observatory/" +
    "data=!4m2!3m1!1s0x6003a9798f2e0eab:0x2871c3655542c94a";
  const embedUrl =
    "https://www.google.com/maps?q=Registered+Observatory&output=embed";
  const embedHtml = `
    <script>
      window.__place = [[[
        "0x6003a9798f2e0eab:0x2871c3655542c94a",
        "1 Observatory Road, Gifu",
        [35.433918,136.7820713],
        "2914325273874975050"
      ],"Registered Observatory",[]]];
    </script>
  `;
  const calls = [];
  const result = await resolveGoogleMapsSharedUrl(shortUrl, {
    requestId: "registered-place-test",
    fetcher: async (url) => {
      const value = String(url);
      calls.push(value);
      if (value === shortUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: finalUrl },
        });
      }
      if (value === finalUrl) {
        return new Response("<html><title>Google Maps</title></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      assert.equal(value, embedUrl);
      return new Response(embedHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  assert.equal(result.latitude, 35.433918);
  assert.equal(result.longitude, 136.7820713);
  assert.equal(result.place.name, "Registered Observatory");
  assert.equal(result.place.formattedAddress, "1 Observatory Road, Gifu");
  assert.equal(result.place.placeIdType, "maps-feature-id");
  assert.equal(result.diagnostics.extractionSource, "google-maps-embed");
  assert.deepEqual(calls, [shortUrl, finalUrl, embedUrl]);
});

test("Google Maps resolver errors include HTTP and redirect diagnostics", async () => {
  await assert.rejects(
    resolveGoogleMapsSharedUrl("https://maps.app.goo.gl/failingFixture", {
      requestId: "resolver-error-test",
      fetcher: async () => new Response("temporary upstream failure", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }),
    }),
    (error) => {
      assert.ok(error instanceof GoogleMapsResolutionError);
      assert.equal(error.code, "GOOGLE_HTTP_ERROR");
      assert.equal(error.diagnostics.requestId, "resolver-error-test");
      assert.equal(error.diagnostics.redirectChain[0].status, 503);
      assert.match(error.diagnostics.attempts[0].detail, /temporary upstream failure/u);
      return true;
    }
  );
});

test("Google Maps Pages Function returns structured error logs", async () => {
  const request = new Request("https://astrosight.example/api/resolve-google-maps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/not-google-maps" }),
  });
  const response = await resolveGoogleMaps(eventContext(request, {}));
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "INVALID_GOOGLE_MAPS_URL");
  assert.equal(typeof body.requestId, "string");
  assert.equal(body.details.sourceUrl, null);
  assert.equal(Array.isArray(body.details.attempts), true);
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
  assert.deepEqual(
    googleMapsPlaceQueryCandidates("Barbara Oliver Jewelry, 5820 Main St"),
    ["Barbara Oliver Jewelry, 5820 Main St"]
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
    criteria: {
      query: "東京タワー",
      useCurrentSubjectPin: false,
      celestialId: "moon",
      sunSearchTiming: "all",
      moonAgeMinDays: 0,
      moonAgeMaxDays: 30,
      focalLengthMm: 50,
      tripodDistanceMinMeters: 50,
      tripodDistanceMaxMeters: 500,
      period: "1-month",
      customStartDate: "2026-08-01",
      customEndDate: "2026-08-31",
      weekdays: [],
      interval: "30-minutes",
      displayCount: 10,
      siteConstraints: {
        walkingOnly: true,
        roadsAndPathsOnly: false,
        excludePrivateAccess: false,
        elevationDifferenceWithin100m: false,
        excludeRoads: false,
      },
    },
    subject: {
      latitude: 35.6586,
      longitude: 139.7454,
      height: 350,
      label: "東京タワー",
    },
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
  assert.equal(kv.putCount, 1);

  const duplicateStartRequest = new Request("https://astrosight.example/api/spot-search-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, jobId, input }),
  });
  const duplicateStartResponse = await startSearch(eventContext(duplicateStartRequest, env));
  assert.equal(duplicateStartResponse.status, 202);
  assert.deepEqual(await duplicateStartResponse.json(), { jobId, status: "queued" });
  assert.equal(queue.messages.length, 1);
  assert.equal(kv.putCount, 1);

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
  const putCountBeforeFinalize = kv.putCount;
  const finalizeResponse = await finalizeSearch(eventContext(finalizeRequest, env));
  assert.equal(finalizeResponse.status, 200);
  assert.equal((await finalizeResponse.json()).status, "complete");
  assert.equal(kv.putCount, putCountBeforeFinalize);
  const finalized = JSON.parse(kv.values.get(storedKey));
  assert.equal(finalized.job.status, "awaiting-3d");
  assert.deepEqual(finalized.partialResult, partialResult);
  assert.equal(finalized.finalResult, undefined);
});
