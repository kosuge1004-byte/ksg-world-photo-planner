import {
  extractGoogleMapsCoordinates,
  extractGoogleMapsPlaceMetadata,
  extractGoogleMapsSharedUrl,
  isAllowedGoogleMapsHost,
  isSupportedGoogleMapsUrl,
  type GoogleMapsCoordinates,
  type GoogleMapsPlaceMetadata,
} from "../src/search/googleMapsUrl.ts";

export type GoogleMapsPlaceInfo = {
  placeId: string | null;
  placeIdType: "places-api" | "maps-feature-id" | "cid" | null;
  googleMapsFeatureId: string | null;
  cid: string | null;
  name: string | null;
  formattedAddress: string | null;
  query: string | null;
};

export type GoogleMapsRedirectLog = {
  hop: number;
  status: number;
  url: string;
  location: string | null;
};

export type GoogleMapsResolutionAttempt = {
  stage: string;
  outcome: "success" | "miss" | "skipped" | "error";
  detail: string;
  status?: number;
  url?: string;
};

export type GoogleMapsResolutionDiagnostics = {
  requestId: string;
  sourceUrl: string | null;
  finalUrl: string | null;
  redirectCount: number;
  redirectChain: GoogleMapsRedirectLog[];
  attempts: GoogleMapsResolutionAttempt[];
  extractionSource: string | null;
  elapsedMs: number;
};

export type ResolvedGoogleMapsLocation = {
  latitude: number;
  longitude: number;
  resolvedUrl: string;
  label: string;
  place: GoogleMapsPlaceInfo;
  diagnostics: GoogleMapsResolutionDiagnostics;
};

export type ResolveGoogleMapsOptions = {
  fetcher?: typeof fetch;
  googleMapsApiKey?: string;
  requestId?: string;
  timeoutMs?: number;
};

export class GoogleMapsResolutionError extends Error {
  readonly code: string;
  readonly diagnostics: GoogleMapsResolutionDiagnostics;

  constructor(
    code: string,
    message: string,
    diagnostics: GoogleMapsResolutionDiagnostics
  ) {
    super(message);
    this.name = "GoogleMapsResolutionError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

type CoordinateCandidate = GoogleMapsCoordinates & {
  source: string;
};

type PlaceLookupResult = {
  coordinates: GoogleMapsCoordinates | null;
  metadata: GoogleMapsPlaceMetadata;
};

const GOOGLE_REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
  "Cache-Control": "no-cache",
} as const;

const MAX_REDIRECT_HOPS = 20;
const MAX_URL_LENGTH = 8_192;
const MAX_HTML_LENGTH = 2_500_000;
const DEFAULT_TIMEOUT_MS = 25_000;

const EMPTY_PLACE_METADATA: GoogleMapsPlaceMetadata = {
  placeId: null,
  placeIdType: null,
  googleMapsFeatureId: null,
  cid: null,
  placeQuery: null,
  placeName: null,
  formattedAddress: null,
};

function makeRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `google-maps-${Date.now().toString(36)}`;
  }
}

function truncateLogValue(value: string, maximum = 2_048): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function newDiagnostics(requestId: string): GoogleMapsResolutionDiagnostics {
  return {
    requestId,
    sourceUrl: null,
    finalUrl: null,
    redirectCount: 0,
    redirectChain: [],
    attempts: [],
    extractionSource: null,
    elapsedMs: 0,
  };
}

function addAttempt(
  diagnostics: GoogleMapsResolutionDiagnostics,
  attempt: GoogleMapsResolutionAttempt
): void {
  diagnostics.attempts.push({
    ...attempt,
    detail: truncateLogValue(attempt.detail, 800),
    url: attempt.url ? truncateLogValue(attempt.url) : undefined,
  });
}

function finishDiagnostics(
  diagnostics: GoogleMapsResolutionDiagnostics,
  startedAt: number
): void {
  diagnostics.elapsedMs = Math.max(0, Date.now() - startedAt);
}

function fail(
  code: string,
  message: string,
  diagnostics: GoogleMapsResolutionDiagnostics,
  startedAt: number
): never {
  finishDiagnostics(diagnostics, startedAt);
  throw new GoogleMapsResolutionError(code, message, diagnostics);
}

function decodeGoogleText(value: string): string {
  let decoded = value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#x22;", '"')
    .replace(/\\u002f/giu, "/")
    .replace(/\\u003a/giu, ":")
    .replace(/\\u003d/giu, "=")
    .replace(/\\u0026/giu, "&")
    .replace(/\\u002c/giu, ",")
    .replace(/\\x2f/giu, "/")
    .replace(/\\x3a/giu, ":")
    .replace(/\\x3d/giu, "=")
    .replace(/\\x26/giu, "&")
    .replace(/\\x2c/giu, ",")
    .replaceAll("\\/", "/");
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function allowedGoogleUrl(candidate: string, baseUrl?: string): string | null {
  try {
    const resolved = new URL(decodeGoogleText(candidate), baseUrl);
    if (
      (resolved.protocol !== "https:" && resolved.protocol !== "http:") ||
      !isAllowedGoogleMapsHost(resolved.hostname) ||
      resolved.href.length > MAX_URL_LENGTH
    ) {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

function isLikelyMapsLocationUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const path = url.pathname.toLowerCase();
    if (path.includes("/maps/api/staticmap") || path.includes("/maps/vt")) {
      return false;
    }
    if (url.hostname.toLowerCase().startsWith("maps.google.")) {
      return (
        path === "/" ||
        path === "/maps" ||
        path.startsWith("/maps/place/") ||
        path.startsWith("/maps/search/") ||
        path.startsWith("/maps/dir/") ||
        path.startsWith("/maps/@")
      );
    }
    return isSupportedGoogleMapsUrl(url);
  } catch {
    return false;
  }
}

function extractNestedGoogleMapsUrls(sourceUrl: string): string[] {
  try {
    const url = new URL(sourceUrl);
    const values = new Set<string>();
    for (const name of ["continue", "url", "redirect", "redirect_url"]) {
      const value = url.searchParams.get(name);
      if (!value) continue;
      const resolved = allowedGoogleUrl(value, sourceUrl);
      if (resolved && isLikelyMapsLocationUrl(resolved)) values.add(resolved);
    }
    return [...values];
  } catch {
    return [];
  }
}

function extractGoogleUrlsFromHtml(
  html: string,
  baseUrl: string,
  includeOrdinaryLinks: boolean
): string[] {
  const decoded = decodeGoogleText(html);
  const values = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    const resolved = allowedGoogleUrl(candidate, baseUrl);
    if (resolved) values.add(resolved);
  };

  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/giu,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/giu,
    /<meta[^>]+(?:property|name)=["'](?:og:url|twitter:url)["'][^>]+content=["']([^"']+)["']/giu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:url|twitter:url)["']/giu,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"';]+)[^"']*["']/giu,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/giu,
    /(?:window\.)?location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/giu,
    /["'](?:url|redirectUrl|continueUrl)["']\s*:\s*["']([^"']+)["']/giu,
  ];
  if (includeOrdinaryLinks) {
    patterns.push(
      /href=["'](https?:\/\/[^"']+)["']/giu,
      /(?:https?:\\?\/\\?\/)(?:www\.)?(?:maps\.)?google(?:\.com|\.co\.jp)\\?\/[^\s"'<>]+/giu
    );
  }
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) add(match[1] ?? match[0]);
  }
  return [...values];
}

function structuredCoordinatesFromHtml(html: string): GoogleMapsCoordinates | null {
  const decoded = decodeGoogleText(html);
  const snippets = [
    decoded.match(/!3d-?\d+(?:\.\d+)?!4d-?\d+(?:\.\d+)?/u)?.[0],
    decoded.match(
      /["'](?:latitude|lat)["']\s*[:=]\s*-?\d+(?:\.\d+)?[\s\S]{0,160}?["'](?:longitude|lng|lon)["']\s*[:=]\s*-?\d+(?:\.\d+)?/iu
    )?.[0],
    decoded.match(
      /["'](?:longitude|lng|lon)["']\s*[:=]\s*-?\d+(?:\.\d+)?[\s\S]{0,160}?["'](?:latitude|lat)["']\s*[:=]\s*-?\d+(?:\.\d+)?/iu
    )?.[0],
    decoded.match(
      /\[\s*null\s*,\s*null\s*,\s*-?\d{1,2}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\s*\]/u
    )?.[0],
  ];
  for (const snippet of snippets) {
    if (!snippet) continue;
    const coordinates = extractGoogleMapsCoordinates(snippet);
    if (coordinates) return coordinates;
  }
  return null;
}

function mergeMetadata(
  ...items: Array<GoogleMapsPlaceMetadata | null | undefined>
): GoogleMapsPlaceMetadata {
  const values = items.filter(
    (item): item is GoogleMapsPlaceMetadata => Boolean(item)
  );
  const placesApi = values.find((item) => item.placeIdType === "places-api");
  const identifier = placesApi ?? values.find((item) => item.placeId);
  return {
    placeId: identifier?.placeId ?? null,
    placeIdType: identifier?.placeIdType ?? null,
    googleMapsFeatureId:
      values.find((item) => item.googleMapsFeatureId)?.googleMapsFeatureId ?? null,
    cid: values.find((item) => item.cid)?.cid ?? null,
    placeQuery: values.find((item) => item.placeQuery)?.placeQuery ?? null,
    placeName: values.find((item) => item.placeName)?.placeName ?? null,
    formattedAddress:
      values.find((item) => item.formattedAddress)?.formattedAddress ?? null,
  };
}

function metadataFromPlaceLookup(value: unknown): PlaceLookupResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const location =
    typeof record.location === "object" && record.location !== null
      ? (record.location as Record<string, unknown>)
      : null;
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  const coordinates =
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
      ? { latitude, longitude }
      : null;
  const displayName =
    typeof record.displayName === "object" && record.displayName !== null
      ? (record.displayName as Record<string, unknown>).text
      : null;
  const placeId = typeof record.id === "string" ? record.id : null;
  return {
    coordinates,
    metadata: {
      ...EMPTY_PLACE_METADATA,
      placeId,
      placeIdType: placeId ? "places-api" : null,
      placeName: typeof displayName === "string" ? displayName : null,
      formattedAddress:
        typeof record.formattedAddress === "string"
          ? record.formattedAddress
          : null,
    },
  };
}

async function googlePlacesLookup(
  metadata: GoogleMapsPlaceMetadata,
  apiKey: string,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<PlaceLookupResult | null> {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask":
      "id,displayName,formattedAddress,location",
  } as const;

  let response: Response;
  if (metadata.placeIdType === "places-api" && metadata.placeId) {
    response = await fetcher(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(metadata.placeId)}?languageCode=ja`,
      { method: "GET", headers, signal, redirect: "error" }
    );
  } else if (metadata.placeQuery) {
    response = await fetcher("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        ...headers,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({
        textQuery: metadata.placeQuery,
        languageCode: "ja",
        regionCode: "JP",
        pageSize: 1,
      }),
      signal,
      redirect: "error",
    });
  } else {
    return null;
  }

  if (!response.ok) {
    const body = truncateLogValue(await response.text(), 500);
    throw new Error(`Google Places API ${response.status}: ${body}`);
  }
  const json = await response.json() as unknown;
  if (
    typeof json === "object" &&
    json !== null &&
    Array.isArray((json as Record<string, unknown>).places)
  ) {
    return metadataFromPlaceLookup(
      ((json as Record<string, unknown>).places as unknown[])[0]
    );
  }
  return metadataFromPlaceLookup(json);
}

async function googleMapsEmbedLookup(
  query: string,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<PlaceLookupResult | null> {
  for (const candidate of googleMapsPlaceQueryCandidates(query)) {
    const parameters = new URLSearchParams({ q: candidate, output: "embed" });
    const response = await fetcher(
      `https://www.google.com/maps?${parameters}`,
      {
        method: "GET",
        headers: GOOGLE_REQUEST_HEADERS,
        signal,
        redirect: "follow",
      }
    );
    if (!response.ok) {
      throw new Error(`Google Maps登録地点検索エラー：${response.status}`);
    }
    const html = await responseText(response);
    const coordinates = extractGoogleMapsCoordinates(html);
    if (!coordinates) continue;
    return {
      coordinates,
      metadata: mergeMetadata(
        extractGoogleMapsPlaceMetadata(response.url),
        extractGoogleMapsPlaceMetadata(html),
        { ...EMPTY_PLACE_METADATA, placeQuery: query }
      ),
    };
  }
  return null;
}

export function googleMapsPlaceQueryCandidates(query: string): string[] {
  const normalized = query.replace(/\s+/gu, " ").trim();
  const candidates = new Set<string>();
  const add = (value: string): void => {
    const candidate = value.trim();
    if (candidate) candidates.add(candidate.slice(0, 200));
  };
  add(normalized);
  const withoutPostalCode = normalized.replace(/^〒?\d{3}-?\d{4}\s*/u, "");
  add(withoutPostalCode);
  const words = withoutPostalCode.split(" ").filter(Boolean);
  const needsJapaneseLandmarkFallback =
    /^〒?\d{3}-?\d{4}/u.test(normalized) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
  if (needsJapaneseLandmarkFallback && words.length > 1) {
    add(words.at(-1) ?? "");
    add(words.slice(-2).join(" "));
  }
  return [...candidates];
}

async function nominatimPlaceLookup(
  query: string,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<PlaceLookupResult | null> {
  for (const candidate of googleMapsPlaceQueryCandidates(query)) {
    const parameters = new URLSearchParams({
      q: candidate,
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
      namedetails: "1",
      "accept-language": "ja",
    });
    const response = await fetcher(
      `https://nominatim.openstreetmap.org/search?${parameters}`,
      {
        headers: {
          Accept: "application/json",
          "Accept-Language": "ja-JP,ja;q=0.9",
          "User-Agent": "AstroSight/0.0.0",
        },
        signal,
        redirect: "follow",
      }
    );
    if (!response.ok) {
      throw new Error(`地名検索通信エラー：${response.status}`);
    }
    const json = await response.json() as unknown;
    if (!Array.isArray(json)) continue;
    for (const item of json) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const latitude = Number(record.lat);
      const longitude = Number(record.lon);
      if (
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
      ) {
        continue;
      }
      const displayName =
        typeof record.display_name === "string" ? record.display_name : null;
      return {
        coordinates: { latitude, longitude },
        metadata: {
          ...EMPTY_PLACE_METADATA,
          placeQuery: query,
          placeName: candidate,
          formattedAddress: displayName,
        },
      };
    }
  }
  return null;
}

async function responseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.length <= MAX_HTML_LENGTH ? text : text.slice(0, MAX_HTML_LENGTH);
}

function placeInfo(metadata: GoogleMapsPlaceMetadata): GoogleMapsPlaceInfo {
  return {
    placeId: metadata.placeId,
    placeIdType: metadata.placeIdType,
    googleMapsFeatureId: metadata.googleMapsFeatureId,
    cid: metadata.cid,
    name: metadata.placeName,
    formattedAddress: metadata.formattedAddress,
    query: metadata.placeQuery,
  };
}

function resolvedResult(
  coordinates: GoogleMapsCoordinates,
  resolvedUrl: string,
  metadata: GoogleMapsPlaceMetadata,
  diagnostics: GoogleMapsResolutionDiagnostics,
  startedAt: number,
  extractionSource: string
): ResolvedGoogleMapsLocation {
  diagnostics.finalUrl = resolvedUrl;
  diagnostics.extractionSource = extractionSource;
  finishDiagnostics(diagnostics, startedAt);
  return {
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    resolvedUrl,
    label:
      metadata.placeName ??
      metadata.formattedAddress ??
      metadata.placeQuery ??
      "Googleマップ共有地点",
    place: placeInfo(metadata),
    diagnostics,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export async function resolveGoogleMapsSharedUrl(
  input: string,
  options: ResolveGoogleMapsOptions = {}
): Promise<ResolvedGoogleMapsLocation> {
  const startedAt = Date.now();
  const diagnostics = newDiagnostics(options.requestId ?? makeRequestId());
  const sourceUrl = extractGoogleMapsSharedUrl(input);
  if (!sourceUrl) {
    fail(
      "INVALID_GOOGLE_MAPS_URL",
      "対応しているGoogleマップ共有URLではありません",
      diagnostics,
      startedAt
    );
  }
  diagnostics.sourceUrl = sourceUrl;
  const fetcher = options.fetcher ?? fetch;
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  let currentUrl = sourceUrl;
  let finalUrl = sourceUrl;
  let finalHtml = "";
  let metadata = extractGoogleMapsPlaceMetadata(sourceUrl);
  const inputCoordinates = extractGoogleMapsCoordinates(sourceUrl);
  let coordinateCandidate: CoordinateCandidate | null = inputCoordinates
    ? { ...inputCoordinates, source: "input-url" }
    : null;
  const visited = new Set<string>();

  const rememberCoordinates = (url: string, source: string): void => {
    const coordinates = extractGoogleMapsCoordinates(url);
    if (coordinates) coordinateCandidate = { ...coordinates, source };
  };
  try {
    if (coordinateCandidate) {
      addAttempt(diagnostics, {
        stage: "input-url",
        outcome: "success",
        detail: "入力URLから座標を取得しました",
        url: sourceUrl,
      });
      return resolvedResult(
        coordinateCandidate,
        sourceUrl,
        metadata,
        diagnostics,
        startedAt,
        coordinateCandidate.source
      );
    }

    let reachedFinalResponse = false;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      if (visited.has(currentUrl)) {
        fail(
          "REDIRECT_LOOP",
          "Googleマップ共有リンクが循環しています",
          diagnostics,
          startedAt
        );
      }
      visited.add(currentUrl);
      metadata = mergeMetadata(metadata, extractGoogleMapsPlaceMetadata(currentUrl));
      rememberCoordinates(currentUrl, hop === 0 ? "input-url" : "redirect-url");

      let response: Response;
      try {
        response = await fetcher(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: abortController.signal,
          headers: GOOGLE_REQUEST_HEADERS,
        });
      } catch (error) {
        addAttempt(diagnostics, {
          stage: "redirect-fetch",
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          url: currentUrl,
        });
        throw error;
      }

      const location = response.headers.get("location");
      diagnostics.redirectChain.push({
        hop,
        status: response.status,
        url: truncateLogValue(currentUrl),
        location: location ? truncateLogValue(location) : null,
      });

      if (response.status >= 300 && response.status < 400) {
        if (!location) {
          addAttempt(diagnostics, {
            stage: "redirect-fetch",
            outcome: "miss",
            detail: "3xx応答にLocationがないため標準fetch追跡へ切り替えます",
            status: response.status,
            url: currentUrl,
          });
          const followed = await fetcher(sourceUrl, {
            method: "GET",
            redirect: "follow",
            signal: abortController.signal,
            headers: GOOGLE_REQUEST_HEADERS,
          });
          finalUrl = allowedGoogleUrl(followed.url || sourceUrl) ?? sourceUrl;
          diagnostics.redirectCount = Math.max(hop, 1);
          diagnostics.finalUrl = finalUrl;
          if (!followed.ok) {
            fail(
              "GOOGLE_HTTP_ERROR",
              `Googleマップ共有リンク通信エラー：${followed.status}`,
              diagnostics,
              startedAt
            );
          }
          finalHtml = await responseText(followed);
          reachedFinalResponse = true;
          break;
        }
        const nextUrl = allowedGoogleUrl(location, currentUrl);
        if (!nextUrl) {
          fail(
            "REDIRECT_TARGET_REJECTED",
            "Googleマップ共有リンクの転送先が許可されていません",
            diagnostics,
            startedAt
          );
        }
        diagnostics.redirectCount += 1;
        metadata = mergeMetadata(metadata, extractGoogleMapsPlaceMetadata(nextUrl));
        rememberCoordinates(nextUrl, "redirect-location");
        currentUrl = nextUrl;
        continue;
      }

      finalUrl = allowedGoogleUrl(response.url || currentUrl) ?? currentUrl;
      diagnostics.finalUrl = finalUrl;
      if (!response.ok) {
        const snippet = truncateLogValue(await responseText(response), 300);
        addAttempt(diagnostics, {
          stage: "final-response",
          outcome: "error",
          detail: `HTTP ${response.status}: ${snippet}`,
          status: response.status,
          url: finalUrl,
        });
        fail(
          "GOOGLE_HTTP_ERROR",
          `Googleマップ共有リンク通信エラー：${response.status}`,
          diagnostics,
          startedAt
        );
      }
      finalHtml = await responseText(response);
      reachedFinalResponse = true;
      metadata = mergeMetadata(
        metadata,
        extractGoogleMapsPlaceMetadata(finalUrl),
        extractGoogleMapsPlaceMetadata(finalHtml)
      );
      rememberCoordinates(finalUrl, "final-url");

      const htmlUrls = extractGoogleUrlsFromHtml(finalHtml, finalUrl, true)
        .filter(isLikelyMapsLocationUrl);
      for (const candidate of htmlUrls) {
        metadata = mergeMetadata(metadata, extractGoogleMapsPlaceMetadata(candidate));
        if (!coordinateCandidate) rememberCoordinates(candidate, "html-url");
      }
      if (!coordinateCandidate) {
        const structured = structuredCoordinatesFromHtml(finalHtml);
        if (structured) {
          coordinateCandidate = { ...structured, source: "html-structured-data" };
        }
      }

      let finalIsMapsPage = false;
      try {
        finalIsMapsPage = isSupportedGoogleMapsUrl(new URL(finalUrl));
      } catch {
        // URLはallowedGoogleUrlで検証済み。念のためfalseで継続する。
      }
      if (!finalIsMapsPage) {
        const clientRedirect = [
          ...extractNestedGoogleMapsUrls(finalUrl),
          ...extractGoogleUrlsFromHtml(finalHtml, finalUrl, false),
        ].find((candidate) => !visited.has(candidate) && isLikelyMapsLocationUrl(candidate));
        if (clientRedirect) {
          addAttempt(diagnostics, {
            stage: "html-redirect",
            outcome: "success",
            detail: "HTML内のGoogle Maps転送先を追跡します",
            url: clientRedirect,
          });
          currentUrl = clientRedirect;
          reachedFinalResponse = false;
          continue;
        }
      }
      break;
    }

    if (!reachedFinalResponse) {
      fail(
        "REDIRECT_LIMIT",
        `Googleマップ共有リンクの転送回数が${MAX_REDIRECT_HOPS}回を超えました`,
        diagnostics,
        startedAt
      );
    }

    metadata = mergeMetadata(
      metadata,
      extractGoogleMapsPlaceMetadata(finalUrl),
      finalHtml ? extractGoogleMapsPlaceMetadata(finalHtml) : null
    );

    let placesResult: PlaceLookupResult | null = null;
    if (options.googleMapsApiKey && (metadata.placeId || metadata.placeQuery)) {
      try {
        placesResult = await googlePlacesLookup(
          metadata,
          options.googleMapsApiKey,
          fetcher,
          abortController.signal
        );
        addAttempt(diagnostics, {
          stage: "google-places",
          outcome: placesResult ? "success" : "miss",
          detail: placesResult
            ? "Google Places APIからPlace IDと地点情報を取得しました"
            : "Google Places APIに一致する地点がありませんでした",
        });
      } catch (error) {
        addAttempt(diagnostics, {
          stage: "google-places",
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      addAttempt(diagnostics, {
        stage: "google-places",
        outcome: "skipped",
        detail: options.googleMapsApiKey
          ? "Place IDまたは地点クエリがないため省略しました"
          : "GOOGLE_MAPS_API_KEYが未設定のため省略しました",
      });
    }
    if (placesResult) {
      metadata = mergeMetadata(placesResult.metadata, metadata);
      if (!coordinateCandidate && placesResult.coordinates) {
        coordinateCandidate = {
          ...placesResult.coordinates,
          source: "google-places-api",
        };
      }
    }

    if (!coordinateCandidate && metadata.placeQuery) {
      try {
        const embeddedPlace = await googleMapsEmbedLookup(
          metadata.placeQuery,
          fetcher,
          abortController.signal
        );
        addAttempt(diagnostics, {
          stage: "google-maps-embed",
          outcome: embeddedPlace ? "success" : "miss",
          detail: embeddedPlace
            ? "Google Maps登録地点データから座標と地点情報を取得しました"
            : "Google Maps登録地点データに座標がありませんでした",
        });
        if (embeddedPlace) {
          metadata = mergeMetadata(embeddedPlace.metadata, metadata);
          coordinateCandidate = {
            ...embeddedPlace.coordinates!,
            source: "google-maps-embed",
          };
        }
      } catch (error) {
        addAttempt(diagnostics, {
          stage: "google-maps-embed",
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (
      metadata.placeQuery &&
      (!coordinateCandidate || !metadata.placeName || !metadata.formattedAddress)
    ) {
      try {
        const nominatim = await nominatimPlaceLookup(
          metadata.placeQuery,
          fetcher,
          abortController.signal
        );
        addAttempt(diagnostics, {
          stage: "place-geocode",
          outcome: nominatim ? "success" : "miss",
          detail: nominatim
            ? "地点名から座標と表示住所を補完しました"
            : "地点名に一致する座標がありませんでした",
        });
        if (nominatim) {
          metadata = mergeMetadata(metadata, nominatim.metadata);
          if (!coordinateCandidate && nominatim.coordinates) {
            coordinateCandidate = {
              ...nominatim.coordinates,
              source: "place-geocode",
            };
          }
        }
      } catch (error) {
        addAttempt(diagnostics, {
          stage: "place-geocode",
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (coordinateCandidate) {
      addAttempt(diagnostics, {
        stage: "coordinate-resolution",
        outcome: "success",
        detail: `座標取得元：${coordinateCandidate.source}`,
        url: finalUrl,
      });
      return resolvedResult(
        coordinateCandidate,
        finalUrl,
        metadata,
        diagnostics,
        startedAt,
        coordinateCandidate.source
      );
    }

    if (/\/maps\/d\//u.test(new URL(finalUrl).pathname)) {
      fail(
        "GOOGLE_MY_MAPS_UNSUPPORTED",
        "この共有URLは複数地点を含むGoogleマイマップです。対象地点を1つ開いた共有URLを使用してください",
        diagnostics,
        startedAt
      );
    }
    fail(
      "COORDINATES_NOT_FOUND",
      "共有リンクの最終転送先から地点座標を取得できませんでした",
      diagnostics,
      startedAt
    );
  } catch (error) {
    if (error instanceof GoogleMapsResolutionError) throw error;
    if (isAbortError(error)) {
      fail(
        "TIMEOUT",
        "Googleマップ共有リンクの解析がタイムアウトしました",
        diagnostics,
        startedAt
      );
    }
    addAttempt(diagnostics, {
      stage: "unhandled",
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
      url: currentUrl,
    });
    fail(
      "NETWORK_OR_PARSE_ERROR",
      `Googleマップ共有リンクの通信または解析に失敗しました：${error instanceof Error ? error.message : String(error)}`,
      diagnostics,
      startedAt
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
