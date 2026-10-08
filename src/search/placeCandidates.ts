import {
  searchJapanesePlaceCandidates,
  type PlaceCandidate,
  type PlaceSearchCenter,
} from "../../server/placeGeocode.ts";
import {
  cleanPlaceQuery,
  normalizedPlaceText,
} from "../../server/placeTextNormalization.ts";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { isAbortError } from "../utils/runtimeErrors";
import { extractGoogleMapsSharedUrl } from "./googleMapsUrl";
import {
  findRegisteredSpotMatches,
  snapSpotLocationToRegisteredLandmark,
  type ResolvedSpotLocation,
} from "./spotPresetSearch";

/**
 * 2026-10-08: スポット検索の候補一覧（入力補完・複数候補からの選択）。
 *
 * - suggest（入力途中）: 端末から直接Photonへ問い合わせる。Pages Functionsの
 *   リクエスト数を消費せず、利用者ごとのIPで公開サーバーの公平利用に収まる。
 * - search（検索確定）: /api/place-search（Nominatim＋国土地理院＋Photonを統合、
 *   R2保存）を使い、失敗時は端末から同じ処理を直接実行する。
 * どちらも登録スポット・保存済みスポットを先頭に加える（通信なし）。
 */
export type SpotCandidate = {
  id: string;
  name: string;
  detail: string;
  kind: string | null;
  origin: "registered" | "saved" | "search";
  /** 登録スポット・保存済みスポットの名称と検索語が完全一致。 */
  exactRegistered: boolean;
  distanceKm?: number;
  location: ResolvedSpotLocation;
};

export type SpotCandidateMode = "suggest" | "search";

const SUGGEST_MIN_LENGTH = 2;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 60;
const remoteCache = new Map<string, { expiresAt: number; value: PlaceCandidate[] }>();

/** 座標の直接入力、またはGoogleマップ共有URL。候補一覧を出さず従来どおり直接解決する。 */
export function isDirectLocationQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (/^\s*-?\d{1,2}(?:\.\d+)?\s*[,、]\s*-?\d{1,3}(?:\.\d+)?\s*$/u.test(trimmed.normalize("NFKC"))) {
    return true;
  }
  return /^https?:\/\//iu.test(trimmed) || extractGoogleMapsSharedUrl(trimmed) !== null;
}

/** 入力途中の候補表示を行う検索語か。 */
export function shouldSuggestForQuery(query: string): boolean {
  if (isDirectLocationQuery(query)) return false;
  return normalizedPlaceText(query).length >= SUGGEST_MIN_LENGTH;
}

function validCenter(center: PlaceSearchCenter | null | undefined): PlaceSearchCenter | null {
  if (!center) return null;
  return Number.isFinite(center.latitude) && Number.isFinite(center.longitude) &&
    Math.abs(center.latitude) <= 90 && Math.abs(center.longitude) <= 180
    ? { latitude: center.latitude, longitude: center.longitude }
    : null;
}

function distanceKilometers(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const toRadians = Math.PI / 180;
  const lat1 = a.latitude * toRadians;
  const lat2 = b.latitude * toRadians;
  const dLat = lat2 - lat1;
  const dLon = (b.longitude - a.longitude) * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const REGISTERED_KIND_LABELS: Record<string, string> = {
  mountain: "山", natural: "自然", castle: "城", themepark: "テーマパーク", building: "建物",
  tower: "塔", temple: "寺社", ferriswheel: "観覧車", rollercoaster: "コースター",
};

function locationFromPlaceCandidate(candidate: PlaceCandidate): ResolvedSpotLocation | null {
  const latitude = Number(candidate.latitude);
  const longitude = Number(candidate.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
    typeof candidate.label !== "string" || !candidate.label) return null;
  const structure = candidate.subjectSurfaceTarget === "structure-roof";
  const height = Number(candidate.structureHeightMeters);
  // /api/geocode の応答を解釈する既存処理（resolveSpotLocation）と同じ規則。
  return {
    latitude,
    longitude,
    label: candidate.label,
    subjectSurfaceTarget: structure ? "structure-roof" : undefined,
    structureHeightMeters: Number.isFinite(height) && height > 0 ? height : undefined,
    category: typeof candidate.category === "string" ? candidate.category : "unknown",
    heightSourceType: candidate.heightSourceType === "osm-height" ||
      candidate.heightSourceType === "osm-levels-estimate"
      ? candidate.heightSourceType
      : structure ? "unknown" : undefined,
    heightSourceUrl: typeof candidate.heightSourceUrl === "string" ? candidate.heightSourceUrl : null,
    heightSourceLabel: typeof candidate.heightSourceLabel === "string" ? candidate.heightSourceLabel : null,
    heightStatus: candidate.heightStatus === "estimated" ? "estimated" : structure ? "unknown" : undefined,
    locationSource: "search",
  };
}

function isPlaceCandidate(value: unknown): value is PlaceCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlaceCandidate>;
  return typeof candidate.name === "string" && candidate.name.length > 0 &&
    typeof candidate.label === "string" &&
    Number.isFinite(Number(candidate.latitude)) && Number.isFinite(Number(candidate.longitude));
}

async function requestRemoteCandidates(
  query: string,
  mode: SpotCandidateMode,
  center: PlaceSearchCenter | null,
  signal?: AbortSignal
): Promise<PlaceCandidate[]> {
  if (mode === "search") {
    try {
      const response = await diagnosticFetch("place-search", "/api/place-search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, mode, center }),
        signal,
      });
      const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
      if (response.ok && isJson) {
        const body = await response.json() as { candidates?: unknown };
        if (Array.isArray(body.candidates)) return body.candidates.filter(isPlaceCandidate);
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      // 下の端末直接検索へ進む（/api/geocode と同じfail-open方針）。
    }
  }
  return searchJapanesePlaceCandidates(query, { mode, center }, signal);
}

/**
 * 候補一覧を取得する。suggestは通信失敗を候補なしとして扱い（入力の邪魔を
 * しない）、searchは登録スポットの候補も無く通信も失敗した場合だけ例外を返す。
 */
export async function fetchSpotCandidates(
  rawQuery: string,
  options: {
    mode: SpotCandidateMode;
    center?: PlaceSearchCenter | null;
    signal?: AbortSignal;
  }
): Promise<SpotCandidate[]> {
  const query = cleanPlaceQuery(rawQuery);
  if (!query) return [];
  const center = validCenter(options.center);
  const registered = findRegisteredSpotMatches(query, options.mode === "suggest" ? 3 : 5);

  const cell = center
    ? `${Math.round(center.latitude * 2) / 2},${Math.round(center.longitude * 2) / 2}`
    : "none";
  const cacheKey = `${options.mode}|${query.toLocaleLowerCase("ja")}|${cell}`;
  const now = Date.now();
  let remote: PlaceCandidate[] = [];
  const cached = remoteCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    remote = cached.value;
  } else {
    try {
      remote = await requestRemoteCandidates(query, options.mode, center, options.signal);
      if (remoteCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = remoteCache.keys().next().value;
        if (oldest !== undefined) remoteCache.delete(oldest);
      }
      remoteCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, value: remote });
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      if (options.mode === "search" && registered.length === 0) throw error;
      remote = [];
    }
  }

  const candidates: SpotCandidate[] = [];
  const withDistance = (location: ResolvedSpotLocation): { distanceKm?: number } =>
    center ? { distanceKm: Math.round(distanceKilometers(center, location) * 10) / 10 } : {};
  const alreadyListed = (location: ResolvedSpotLocation): boolean =>
    candidates.some((candidate) =>
      Math.abs(candidate.location.latitude - location.latitude) <= 0.0000001 &&
      Math.abs(candidate.location.longitude - location.longitude) <= 0.0000001
    );

  for (const match of registered) {
    if (alreadyListed(match.location)) continue;
    const saved = match.location.locationSource !== "static";
    candidates.push({
      id: `registered:${match.location.latitude},${match.location.longitude}`,
      name: match.location.label,
      detail: match.matchedName !== match.location.label ? `「${match.matchedName}」に一致` : "",
      kind: saved
        ? "保存済みスポット"
        : REGISTERED_KIND_LABELS[match.location.category ?? ""] ?? null,
      origin: saved ? "saved" : "registered",
      exactRegistered: match.exact,
      location: match.location,
      ...withDistance(match.location),
    });
  }

  remote.forEach((place, index) => {
    const resolved = locationFromPlaceCandidate(place);
    if (!resolved) return;
    // 登録スポットを指す検索結果は登録座標へそろえ、上の登録スポット候補と重複させない。
    const location = snapSpotLocationToRegisteredLandmark(resolved);
    if (alreadyListed(location)) return;
    candidates.push({
      id: `search:${index}:${location.latitude},${location.longitude}`,
      name: place.name,
      detail: typeof place.detail === "string" ? place.detail : "",
      kind: typeof place.kind === "string" && place.kind ? place.kind : null,
      origin: "search",
      exactRegistered: false,
      location,
      ...withDistance(location),
    });
  });
  return candidates;
}
