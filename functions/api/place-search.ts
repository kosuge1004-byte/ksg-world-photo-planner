import {
  searchJapanesePlaceCandidates,
  type PlaceCandidate,
  type PlaceSearchCenter,
} from "../../server/placeGeocode.ts";
import { cleanPlaceQuery } from "../../server/placeTextNormalization.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import {
  errorMessage,
  jsonResponse,
  readJsonRequest,
  requestErrorStatus,
} from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

// 2026-10-08: スポット検索の候補一覧API。
// /api/geocode が「1件に確定」するのに対し、こちらは複数候補を返して
// 利用者に選ばせる。検索確定時（mode=search）だけR2へ保存する。入力途中の
// 補完（mode=suggest）は打鍵ごとに検索語が変わるため保存しない。
const MAX_QUERY_LENGTH = 200;

// R2キーが地図の僅かな移動ごとに増えないよう、地図中心は0.5度（約50km）の
// 格子へ丸めてから検索・保存する。正確な距離表示は端末側で計算する。
function centerCell(value: unknown): PlaceSearchCenter | null {
  if (!value || typeof value !== "object") return null;
  const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== "number" || typeof longitude !== "number" ||
    !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude: Math.round(latitude * 2) / 2,
    longitude: Math.round(longitude * 2) / 2,
  };
}

function withoutDistance(candidates: PlaceCandidate[]): PlaceCandidate[] {
  return candidates.map(({ distanceKm: _distanceKm, ...candidate }) => candidate);
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  const { request, env } = context;
  if (request.method !== "POST") return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  try {
    const body = await readJsonRequest(request, 4 * 1024) as {
      query?: unknown;
      mode?: unknown;
      center?: unknown;
    };
    if (typeof body.query !== "string") return jsonResponse({ error: "スポット名がありません" }, 400);
    if (body.query.length > MAX_QUERY_LENGTH) {
      return jsonResponse({ error: `検索文字列は${MAX_QUERY_LENGTH}文字以内で入力してください` }, 400);
    }
    const query = cleanPlaceQuery(body.query);
    if (!query) return jsonResponse({ error: "スポット名を入力してください" }, 400);
    const mode = body.mode === "suggest" ? "suggest" : "search";
    const center = centerCell(body.center);

    if (mode === "suggest") {
      const candidates = withoutDistance(
        await searchJapanesePlaceCandidates(query, { mode, center }, request.signal)
      );
      return jsonResponse({ candidates, cache: "bypass" }, 200, "no-store");
    }

    const result = await getOrCreateR2Json(env.NETWORK_CACHE, env.SPOT_SEARCH_JOBS, request, {
      query,
      center,
    }, {
      namespace: "place-search", version: "v1", ttlSeconds: 14 * 86400,
    }, async () => {
      const candidates = withoutDistance(
        await searchJapanesePlaceCandidates(query, { mode, center }, request.signal)
      );
      // 0件は検索サービス側の一時的な不調でも起こるため、長期保存しない。
      if (candidates.length === 0) throw new Error("指定したスポットが見つかりませんでした");
      return { candidates };
    }, context.waitUntil);
    return jsonResponse({ ...result.value, cache: result.cache }, 200, "public, max-age=3600");
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("見つかりません")) {
      return jsonResponse({ candidates: [], cache: "bypass" }, 200, "no-store");
    }
    return jsonResponse({ error: message }, requestErrorStatus(error, 422));
  }
};
