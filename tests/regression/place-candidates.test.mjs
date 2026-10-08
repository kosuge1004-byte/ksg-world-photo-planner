import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as placeSearch } from "../../functions/api/place-search.ts";
import {
  resolveJapanesePlaceName,
  searchJapanesePlaceCandidates,
} from "../../server/placeGeocode.ts";
import {
  normalizedPlaceText,
  placeQueryVariants,
} from "../../server/placeTextNormalization.ts";
import {
  fetchSpotCandidates,
  isDirectLocationQuery,
  shouldSuggestForQuery,
} from "../../src/search/placeCandidates.ts";
import { findRegisteredSpotMatches } from "../../src/search/spotPresetSearch.ts";

const nominatim = (url) => url.startsWith("https://nominatim.openstreetmap.org/");
const gsi = (url) => url.startsWith("https://msearch.gsi.go.jp/");
const photon = (url) => url.startsWith("https://photon.komoot.io/");
const queryOf = (url) => new URL(url).searchParams.get("q");

function photonFeature(name, longitude, latitude, properties = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: { name, countrycode: "JP", ...properties },
  };
}

test("place text normalization treats spelling variants of one place as equal", () => {
  assert.equal(normalizedPlaceText("霞が関"), normalizedPlaceText("霞ヶ関"));
  assert.equal(normalizedPlaceText("鎌ケ谷"), normalizedPlaceText("鎌ヶ谷"));
  assert.equal(normalizedPlaceText("ＴＯＫＹＯ　タワー"), normalizedPlaceText("tokyoタワー"));
  assert.equal(normalizedPlaceText("とうきょうタワー"), normalizedPlaceText("トウキョウたわー"));
  assert.equal(normalizedPlaceText("髙島屋"), normalizedPlaceText("高島屋"));
  assert.equal(normalizedPlaceText("虎ノ門"), normalizedPlaceText("虎の門"));
  // 地名の「ヶ」ではない「が」「ケ」は変えない。
  assert.notEqual(normalizedPlaceText("富士山が見える丘"), normalizedPlaceText("富士山ヶ見える丘"));
  assert.equal(normalizedPlaceText("ケーキ"), normalizedPlaceText("けーき"));
});

test("query variants start with the input and stay bounded", () => {
  assert.deepEqual(placeQueryVariants("東京タワー"), ["東京タワー"]);
  assert.deepEqual(placeQueryVariants("  霞が関  "), ["霞が関", "霞ヶ関", "霞ケ関"]);
  assert.deepEqual(placeQueryVariants("東京 タワー"), ["東京 タワー", "東京タワー"]);
  assert.deepEqual(placeQueryVariants("すかいつりー"), ["すかいつりー", "スカイツリー"]);
  assert.ok(placeQueryVariants("澤ヶ丘の瀧 之 濱").length <= 4);
  assert.equal(placeQueryVariants("霞が関", 2).length, 2);
});

test("single-result geocoder retries a spelling variant only after zero results", async () => {
  const calls = [];
  const result = await resolveJapanesePlaceName("霞が関ビル", undefined, async (input) => {
    const url = String(input);
    calls.push(url);
    if (nominatim(url) && queryOf(url) === "霞ヶ関ビル") {
      return Response.json([{ lat: "35.671", lon: "139.747", display_name: "霞ヶ関ビル, 千代田区, 東京都", importance: 0.4 }]);
    }
    return Response.json([]);
  });
  assert.equal(result.label, "霞ヶ関ビル, 千代田区, 東京都");
  assert.deepEqual(calls.filter(nominatim).map(queryOf), ["霞が関ビル", "霞ヶ関ビル"]);

  // 先頭の検索語で見つかれば追加通信しない。
  const direct = [];
  await resolveJapanesePlaceName("霞が関", undefined, async (input) => {
    const url = String(input);
    direct.push(url);
    return nominatim(url)
      ? Response.json([{ lat: "35.67", lon: "139.75", display_name: "霞が関, 千代田区, 東京都", importance: 0.4 }])
      : Response.json([]);
  });
  assert.equal(direct.length, 2);
});

test("suggest mode uses Photon only and never calls Nominatim", async () => {
  const calls = [];
  const candidates = await searchJapanesePlaceCandidates("東京タ", {
    mode: "suggest",
    center: { latitude: 35.68, longitude: 139.76 },
  }, undefined, async (input) => {
    const url = String(input);
    calls.push(url);
    assert.ok(photon(url), `unexpected provider: ${url}`);
    return Response.json({
      features: [
        photonFeature("東京タワー", 139.7454, 35.6586, { osm_key: "man_made", osm_value: "tower", city: "港区", state: "東京都" }),
        photonFeature("東京体育館", 139.7126, 35.6796, { osm_key: "leisure", osm_value: "sports_centre", city: "渋谷区", state: "東京都" }),
        photonFeature("Tokyo Tower Replica", 126.9, 37.5, { countrycode: "KR" }),
      ],
    });
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get("lat"), "35.6800");
  assert.equal(url.searchParams.has("lang"), false);
  assert.ok(url.searchParams.get("bbox"));
  assert.deepEqual(candidates.map((candidate) => candidate.name), ["東京タワー", "東京体育館"]);
  assert.equal(candidates[0].kind, "塔");
  assert.equal(candidates[0].detail, "東京都 港区");
  assert.equal(candidates[0].label, "東京タワー, 港区, 東京都");
  assert.equal(candidates[0].subjectSurfaceTarget, "structure-roof");
  assert.equal(candidates[0].heightStatus, "unknown");
  assert.ok(candidates[0].distanceKm < 5);
});

test("suggest mode falls back to GSI when Photon is down", async () => {
  const candidates = await searchJapanesePlaceCandidates("乗鞍岳", { mode: "suggest" }, undefined, async (input) => {
    const url = String(input);
    assert.ok(!nominatim(url));
    if (photon(url)) return new Response("busy", { status: 503 });
    return Response.json([{ geometry: { type: "Point", coordinates: [137.5536, 36.1064] }, properties: { title: "乗鞍岳" } }]);
  });
  assert.deepEqual(candidates.map((candidate) => [candidate.name, candidate.source]), [["乗鞍岳", "gsi"]]);
});

test("search mode merges providers, removes duplicates and keeps OSM height tags", async () => {
  const candidates = await searchJapanesePlaceCandidates("中央タワー", {
    mode: "search",
    center: { latitude: 34.70, longitude: 135.50 },
  }, undefined, async (input) => {
    const url = String(input);
    if (nominatim(url)) {
      assert.ok(new URL(url).searchParams.get("viewbox"));
      return Response.json([
        { lat: "35.6800", lon: "139.7600", display_name: "中央タワー, 丸の内, 千代田区, 東京都, 100-0005, 日本", name: "中央タワー", category: "man_made", type: "tower", importance: 0.3, extratags: { height: "120" } },
        { lat: "34.7000", lon: "135.5000", display_name: "中央タワー, 梅田, 北区, 大阪市, 大阪府, 日本", name: "中央タワー", category: "man_made", type: "tower", importance: 0.3 },
      ]);
    }
    if (gsi(url)) {
      return Response.json([
        // 東京の候補と同じ建物（約20m差）。別候補として二重に出さない。
        { geometry: { type: "Point", coordinates: [139.7602, 35.6801] }, properties: { title: "中央タワー" } },
        { geometry: { type: "Point", coordinates: [141.35, 43.06] }, properties: { title: "札幌市中央区" } },
      ]);
    }
    return Response.json({
      features: [
        // 大阪の候補と同名・近接（約150m差）。
        photonFeature("中央タワー", 135.5015, 34.7005, { osm_key: "building", osm_value: "yes", city: "大阪市", state: "大阪府" }),
        photonFeature("中央タワー前", 135.51, 34.71, { osm_key: "highway", osm_value: "bus_stop", city: "大阪市", state: "大阪府" }),
      ],
    });
  });

  const towers = candidates.filter((candidate) => candidate.name === "中央タワー");
  assert.equal(towers.length, 2, "同じ場所は1候補にまとめる");
  // 名称の一致度が同じなら、地図中心（大阪）に近い方が先。
  assert.equal(towers[0].detail, "大阪府 大阪市 北区");
  assert.equal(towers[0].distanceKm, 0);
  assert.ok(towers[1].distanceKm > 300);
  assert.equal(towers[1].structureHeightMeters, 120);
  assert.equal(towers[1].heightSourceType, "osm-height");
  assert.equal(towers[1].detail, "東京都 千代田区 丸の内");
  // 完全一致の候補は、部分一致・不一致の候補より常に上。
  assert.deepEqual(candidates.slice(0, 2).map((candidate) => candidate.name), ["中央タワー", "中央タワー"]);
  assert.ok(candidates.some((candidate) => candidate.name === "中央タワー前"));
  assert.equal(candidates.at(-1).name, "札幌市中央区");
});

test("search mode returns an empty list for no results and throws only on total outage", async () => {
  const empty = await searchJapanesePlaceCandidates("存在しない場所", { mode: "search" }, undefined, async (input) =>
    photon(String(input)) ? Response.json({ features: [] }) : Response.json([])
  );
  assert.deepEqual(empty, []);
  await assert.rejects(
    searchJapanesePlaceCandidates("東京駅", { mode: "search" }, undefined, async () => {
      throw new TypeError("network unavailable");
    }),
    /network unavailable/u
  );
  // 一部のサービスだけ落ちていても、残りの結果で候補を返す。
  const partial = await searchJapanesePlaceCandidates("東京駅", { mode: "search" }, undefined, async (input) => {
    const url = String(input);
    if (!gsi(url)) throw new TypeError("network unavailable");
    return Response.json([{ geometry: { type: "Point", coordinates: [139.767125, 35.681236] }, properties: { title: "東京駅" } }]);
  });
  assert.equal(partial.length, 1);
});

test("coordinate and shared-URL input bypasses the candidate list", () => {
  assert.equal(isDirectLocationQuery("35.6586, 139.7454"), true);
  assert.equal(isDirectLocationQuery("３５．６５８６、１３９．７４５４"), true);
  assert.equal(isDirectLocationQuery("https://maps.app.goo.gl/abcdEFGH"), true);
  assert.equal(isDirectLocationQuery("東京タワー"), false);
  assert.equal(shouldSuggestForQuery("東"), false);
  assert.equal(shouldSuggestForQuery("東京"), true);
  assert.equal(shouldSuggestForQuery("https://maps.app.goo.gl/abcdEFGH"), false);
});

test("registered spots match by prefix and alias without any network access", () => {
  const exact = findRegisteredSpotMatches("富士山");
  assert.equal(exact[0].exact, true);
  assert.equal(exact[0].location.label, "富士山");
  assert.equal(exact[0].location.locationSource, "static");
  const alias = findRegisteredSpotMatches("八ヶ岳");
  assert.equal(alias[0].location.label, "赤岳（八ヶ岳）");
  assert.equal(alias[0].matchedName, "八ヶ岳");
  // 「ヶ／ケ」の書き分けでも同じ登録スポットに当たる。
  assert.equal(findRegisteredSpotMatches("八ケ岳")[0].location.label, "赤岳（八ヶ岳）");
  assert.equal(findRegisteredSpotMatches("槍").some((match) => match.location.label === "槍ヶ岳" && !match.exact), true);
  assert.deepEqual(findRegisteredSpotMatches(""), []);
});

test("client candidate list puts registered spots first and survives a provider outage", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(photon(url), `suggest must go straight to Photon: ${url}`);
    return Response.json({
      features: [
        // 登録スポット「富士山」を指す検索結果（約100m差）は登録座標へそろえて重複させない。
        photonFeature("富士山", 138.7280, 35.3610, { osm_key: "natural", osm_value: "volcano", state: "静岡県" }),
        photonFeature("富士山駅", 138.7951, 35.4836, { osm_key: "railway", osm_value: "station", city: "富士吉田市", state: "山梨県" }),
      ],
    });
  };
  const list = await fetchSpotCandidates("富士山", { mode: "suggest", center: { latitude: 35.36, longitude: 138.73 } });
  assert.equal(list[0].origin, "registered");
  assert.equal(list[0].exactRegistered, true);
  assert.equal(list.filter((candidate) => candidate.name === "富士山").length, 1);
  const station = list.find((candidate) => candidate.name === "富士山駅");
  assert.equal(station.kind, "駅");
  assert.equal(station.location.locationSource, "search");
  assert.ok(station.distanceKm > 5 && station.distanceKm < 30);

  // 補完は通信失敗でも例外にせず、登録スポットだけを返す。
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  const offline = await fetchSpotCandidates("槍ヶ", { mode: "suggest" });
  // 前方一致（槍ヶ岳）が部分一致（鹿島槍ヶ岳）より先。
  assert.deepEqual(offline.map((candidate) => candidate.name), ["槍ヶ岳", "鹿島槍ヶ岳"]);
  assert.ok(offline.every((candidate) => candidate.origin === "registered"));
});

test("place-search endpoint validates input and returns candidates without distances", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (nominatim(url)) {
      return Response.json([{ lat: "35.6586", lon: "139.7454", display_name: "東京タワー, 港区, 東京都, 日本", name: "東京タワー", category: "man_made", type: "tower", importance: 0.6 }]);
    }
    return photon(url) ? Response.json({ features: [] }) : Response.json([]);
  };
  const call = (body, method = "POST") => placeSearch({
    request: new Request("https://astrosight.pages.dev/api/place-search", {
      method,
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
    env: {},
    waitUntil() {},
  });

  assert.equal((await call({}, "GET")).status, 405);
  assert.equal((await call({ query: 5 })).status, 400);
  assert.equal((await call({ query: "あ".repeat(201) })).status, 400);

  const response = await call({ query: "東京タワー", mode: "search", center: { latitude: 35.6812, longitude: 139.7671 } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].name, "東京タワー");
  assert.equal("distanceKm" in body.candidates[0], false);
  // 地図中心は0.5度格子へ丸めてから外部検索へ渡す。
  const photonUrl = new URL(seen.find(photon));
  assert.equal(photonUrl.searchParams.get("lat"), "35.5000");
  assert.equal(photonUrl.searchParams.get("lon"), "140.0000");

  globalThis.fetch = async (input) => photon(String(input)) ? Response.json({ features: [] }) : Response.json([]);
  const none = await call({ query: "存在しない場所" });
  assert.equal(none.status, 200);
  assert.deepEqual((await none.json()).candidates, []);
});
