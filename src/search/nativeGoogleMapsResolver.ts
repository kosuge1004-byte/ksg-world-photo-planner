import { createAbortError } from "../utils/runtimeErrors";
import {
  Capacitor,
  CapacitorHttp,
  type HttpResponse,
} from "@capacitor/core";

import {
  extractGoogleMapsCoordinates,
  extractGoogleMapsPlaceQuery,
  extractGoogleMapsSharedUrl,
  isAllowedGoogleMapsHost,
  type GoogleMapsCoordinates,
} from "./googleMapsUrl.ts";

export type NativeGoogleMapsResolveResult = GoogleMapsCoordinates & {
  resolvedUrl: string;
};

type NativeGoogleMapsHttpResult = {
  data: unknown;
  headers: Record<string, string>;
  status: number;
  url: string;
};

type NativeGoogleMapsHttpRequest = (
  url: string,
  disableRedirects: boolean,
  signal?: AbortSignal
) => Promise<NativeGoogleMapsHttpResult>;

const GOOGLE_REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
} as const;

const MAX_REDIRECT_HOPS = 20;
const NOMINATIM_SEARCH_URL =
  "https://nominatim.openstreetmap.org/search";

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError("Googleマップ共有URLの解析を中止しました");
  }
}

function responseDataAsText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === null || data === undefined) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function responseHeader(
  headers: Record<string, string>,
  name: string
): string | null {
  const expected = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expected) return value;
  }
  return null;
}

function allowedGoogleMapsUrl(candidate: string, baseUrl?: string): string | null {
  try {
    const url = new URL(candidate, baseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !isAllowedGoogleMapsHost(url.hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function coordinatesFromResponse(
  response: NativeGoogleMapsHttpResult,
  fallbackUrl: string
): NativeGoogleMapsResolveResult | null {
  const resolvedUrl =
    allowedGoogleMapsUrl(response.url) ??
    allowedGoogleMapsUrl(fallbackUrl) ??
    fallbackUrl;
  const fromUrl = extractGoogleMapsCoordinates(resolvedUrl);
  if (fromUrl) return { ...fromUrl, resolvedUrl };

  const fromData = extractGoogleMapsCoordinates(
    responseDataAsText(response.data)
  );
  return fromData ? { ...fromData, resolvedUrl } : null;
}

// 2026-08-29追記: サーバー側（server/googleMaps.ts）にGoogleの429対策
// （指数バックオフ再試行）を追加したのに合わせ、ネイティブ経路（端末
// 自身のIPで通信するため通常は共有IP起因の429は起きにくいが、念のため
// 同じ考え方で対応する）にも同様の再試行を用意する。
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_500;
const RATE_LIMIT_MAX_DELAY_MS = 6_000;

function rateLimitRetryDelayMs(attempt: number): number {
  const exponential = RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1);
  const capped = Math.min(exponential, RATE_LIMIT_MAX_DELAY_MS);
  const jitterRatio = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitterRatio);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

async function capacitorGoogleMapsRequest(
  url: string,
  disableRedirects: boolean,
  signal?: AbortSignal
): Promise<NativeGoogleMapsHttpResult> {
  const fetchOnce = async (): Promise<NativeGoogleMapsHttpResult> => {
    const response: HttpResponse = await CapacitorHttp.get({
      url,
      headers: GOOGLE_REQUEST_HEADERS,
      connectTimeout: 10_000,
      readTimeout: 18_000,
      disableRedirects,
      responseType: "text",
      shouldEncodeUrlParams: false,
    });
    return {
      data: response.data as unknown,
      headers: response.headers,
      status: response.status,
      url: response.url,
    };
  };

  let result = await fetchOnce();
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    if (result.status !== 429) return result;
    if (signal?.aborted) return result;
    await delay(rateLimitRetryDelayMs(attempt), signal);
    if (signal?.aborted) return result;
    result = await fetchOnce();
  }
  return result;
}

async function resolvePlaceQueryNatively(
  query: string
): Promise<GoogleMapsCoordinates | null> {
  const response: HttpResponse = await CapacitorHttp.get({
    url: NOMINATIM_SEARCH_URL,
    params: {
      q: query,
      format: "jsonv2",
      limit: "1",
      countrycodes: "jp",
      "accept-language": "ja",
    },
    headers: {
      Accept: "application/json",
      "Accept-Language": "ja-JP,ja;q=0.9",
      "User-Agent": "AstroSight/1.0",
    },
    connectTimeout: 10_000,
    readTimeout: 18_000,
    responseType: "json",
  });
  if (response.status < 200 || response.status >= 300) return null;

  const rows = Array.isArray(response.data)
    ? (response.data as unknown[])
    : [];
  const first = rows[0];
  if (typeof first !== "object" || first === null) return null;
  const latitude = Number(Reflect.get(first, "lat"));
  const longitude = Number(Reflect.get(first, "lon"));
  return Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
    ? { latitude, longitude }
    : null;
}

export function canResolveGoogleMapsNatively(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * インストール版では `/api/resolve-google-maps` が存在しないため、
 * CapacitorのネイティブHTTPでGoogleの転送を追跡して座標を取得する。
 */
export async function resolveGoogleMapsSharedUrlNatively(
  input: string,
  signal?: AbortSignal,
  request: NativeGoogleMapsHttpRequest = capacitorGoogleMapsRequest
): Promise<NativeGoogleMapsResolveResult> {
  abortIfRequested(signal);
  const sourceUrl = extractGoogleMapsSharedUrl(input);
  if (!sourceUrl) throw new Error("Googleマップの共有URLではありません");

  const direct = extractGoogleMapsCoordinates(sourceUrl);
  if (direct) return { ...direct, resolvedUrl: sourceUrl };

  let lastResponse: NativeGoogleMapsHttpResult | null = null;

  try {
    // 通常はネイティブHTTPの自動転送で短縮URLから最終URLまで一度で取得する。
    lastResponse = await request(sourceUrl, false, signal);
    abortIfRequested(signal);
    const automatic = coordinatesFromResponse(lastResponse, sourceUrl);
    if (automatic) return automatic;
  } catch {
    // 自動転送に失敗した場合も手動転送を試す。
  }

  let currentUrl = sourceUrl;
  const visited = new Set<string>();
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    abortIfRequested(signal);
    if (visited.has(currentUrl)) {
      throw new Error("Googleマップ共有リンクが循環しています");
    }
    visited.add(currentUrl);

    const response = await request(currentUrl, true, signal);
    lastResponse = response;
    const coordinates = coordinatesFromResponse(response, currentUrl);
    if (coordinates) return coordinates;

    const location = responseHeader(response.headers, "location");
    if (
      response.status >= 300 &&
      response.status < 400 &&
      location
    ) {
      const nextUrl = allowedGoogleMapsUrl(location, currentUrl);
      if (!nextUrl) {
        throw new Error("Googleマップ共有リンクの転送先が不正です");
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }

  const candidateUrls = [
    lastResponse?.url,
    currentUrl,
    sourceUrl,
  ].filter((value): value is string => Boolean(value));
  const placeQuery = candidateUrls
    .map((candidate) => extractGoogleMapsPlaceQuery(candidate))
    .find((candidate): candidate is string => Boolean(candidate));
  if (placeQuery) {
    const place = await resolvePlaceQueryNatively(placeQuery);
    abortIfRequested(signal);
    if (place) {
      return {
        ...place,
        resolvedUrl: lastResponse?.url ?? currentUrl,
      };
    }
  }

  if (lastResponse && (lastResponse.status < 200 || lastResponse.status >= 400)) {
    throw new Error(
      `Googleマップ共有リンク通信エラー：${lastResponse.status}`
    );
  }
  throw new Error(
    "Googleマップ共有リンクは開けましたが、座標を取得できませんでした"
  );
}
