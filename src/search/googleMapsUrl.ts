export type GoogleMapsCoordinates = {
  latitude: number;
  longitude: number;
};

export type GoogleMapsPlaceMetadata = {
  placeId: string | null;
  placeIdType: "places-api" | "maps-feature-id" | "cid" | null;
  googleMapsFeatureId: string | null;
  cid: string | null;
  placeQuery: string | null;
  placeName: string | null;
  formattedAddress: string | null;
};

function validCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function isAllowedGoogleMapsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "google.com" ||
    host === "www.google.com" ||
    host === "maps.google.com" ||
    host === "google.co.jp" ||
    host === "www.google.co.jp" ||
    host === "maps.google.co.jp" ||
    host.endsWith(".google.com") ||
    host.endsWith(".google.co.jp")
  );
}

export function isSupportedGoogleMapsUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "maps.app.goo.gl") return path !== "/";
  if (host === "goo.gl") return path === "/maps" || path.startsWith("/maps/");
  if (host === "maps.google.com" || host === "maps.google.co.jp") return true;
  if (
    host === "google.com" ||
    host === "www.google.com" ||
    host === "google.co.jp" ||
    host === "www.google.co.jp"
  ) {
    return path === "/maps" || path.startsWith("/maps/");
  }
  return false;
}

export function extractGoogleMapsSharedUrl(text: string): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const candidate of candidates) {
    // 共有文と一緒に貼られた末尾の日本語句読点や括弧をURLから除外する。
    const cleaned = candidate.replace(/[\])}】）」』、。,]+$/gu, "");
    try {
      const url = new URL(cleaned);
      if (isSupportedGoogleMapsUrl(url)) return url.href;
    } catch {
      // 次のURL候補を確認する。
    }
  }
  return null;
}

function coordinatePair(
  latitudeText: string,
  longitudeText: string
): GoogleMapsCoordinates | null {
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  return validCoordinates(latitude, longitude)
    ? { latitude, longitude }
    : null;
}

/**
 * Google Maps共有ページではURLがHTML entity、JavaScript escape、
 * percent encodingの複数層で格納されることがあるため、座標抽出前に展開する。
 */
function normalizeGoogleMapsText(source: string): string {
  let normalized = source
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#x22;", '"')
    .replaceAll("\\u002f", "/")
    .replaceAll("\\u002F", "/")
    .replaceAll("\\u003a", ":")
    .replaceAll("\\u003A", ":")
    .replaceAll("\\u003d", "=")
    .replaceAll("\\u003D", "=")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\u002c", ",")
    .replaceAll("\\u002C", ",")
    .replaceAll("\\x2f", "/")
    .replaceAll("\\x2F", "/")
    .replaceAll("\\x3a", ":")
    .replaceAll("\\x3A", ":")
    .replaceAll("\\x3d", "=")
    .replaceAll("\\x3D", "=")
    .replaceAll("\\x26", "&")
    .replaceAll("\\x2c", ",")
    .replaceAll("\\x2C", ",")
    .replaceAll("\\/", "/");

  // continueパラメーターなどへ二重符号化された共有URLも展開する。
  for (let pass = 0; pass < 4; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(normalized);
    } catch {
      // 壊れたpercent列を含むHTMLでも、座標用のASCII区切りだけは展開する。
      decoded = normalized.replace(
        /%(21|23|25|26|2C|2F|3A|3D|3F|40)/giu,
        (value) => String.fromCharCode(Number.parseInt(value.slice(1), 16))
      );
    }
    if (decoded === normalized) break;
    normalized = decoded;
  }
  return normalized;
}

function extractCoordinatesFromUrl(
  source: string
): GoogleMapsCoordinates | null {
  try {
    const url = new URL(source);
    for (const parameter of ["query", "q", "destination", "ll", "center"]) {
      const value = url.searchParams.get(parameter);
      const match = value?.match(
        /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u
      );
      if (!match) continue;
      const coordinates = coordinatePair(match[1], match[2]);
      if (coordinates) return coordinates;
    }

    // 現在のGoogle Maps短縮URLは
    // /maps/search/緯度,+経度 の形式へ転送される場合がある。
    const path = decodeURIComponent(url.pathname).replaceAll("+", " ");
    const pathMatch = path.match(
      /\/maps\/(?:search|place|dir)\/(?:[^/]+\/)*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\/|$)/iu
    );
    return pathMatch ? coordinatePair(pathMatch[1], pathMatch[2]) : null;
  } catch {
    return null;
  }
}

export function extractGoogleMapsPlaceQuery(source: string): string | null {
  const normalized = normalizeGoogleMapsText(source);
  try {
    const url = new URL(normalized);
    for (const parameter of ["query", "q", "destination"]) {
      const value = url.searchParams.get(parameter)?.trim();
      if (
        !value ||
        /^place_id:/iu.test(value) ||
        coordinatePair(
          value.split(",")[0] ?? "",
          value.split(",")[1] ?? ""
        )
      ) {
        continue;
      }
      return value.slice(0, 200);
    }

    const path = decodeURIComponent(url.pathname).replaceAll("+", " ");
    const match = path.match(/\/maps\/(?:place|search)\/([^/]+)/iu);
    const value = match?.[1]?.trim();
    if (
      !value ||
      coordinatePair(
        value.split(",")[0] ?? "",
        value.split(",")[1] ?? ""
      )
    ) {
      return null;
    }
    return value.slice(0, 200);
  } catch {
    return null;
  }
}

function safeDecodeUrlComponent(value: string): string {
  let decoded = value.replaceAll("+", " ");
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.trim();
}

function cleanMetadataText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = safeDecodeUrlComponent(value)
    .replace(/<[^>]+>/gu, " ")
    .replace(/\\["']/gu, (match) => match.slice(1))
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || cleaned.length > 500) return null;
  if (/^(?:Google(?: Maps)?|Google マップ)$/iu.test(cleaned)) return null;
  return cleaned;
}

function validPlacesApiId(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = safeDecodeUrlComponent(value).replace(/^places\//u, "");
  return /^[A-Za-z0-9_-]{10,256}$/u.test(cleaned) && !/^0x/iu.test(cleaned)
    ? cleaned
    : null;
}

function googleMapsFeatureId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = safeDecodeUrlComponent(value).match(
    /0x[0-9a-f]+:0x[0-9a-f]+/iu
  );
  return match?.[0]?.toLowerCase() ?? null;
}

function featureIdCid(featureId: string | null): string | null {
  const hexadecimal = featureId?.split(":").at(-1);
  if (!hexadecimal || !/^0x[0-9a-f]+$/iu.test(hexadecimal)) return null;
  try {
    return BigInt(hexadecimal).toString(10);
  } catch {
    return null;
  }
}

function htmlMetadataValue(
  source: string,
  names: readonly string[]
): string | null {
  const alternation = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name|itemprop)=["'](?:${alternation})["'][^>]+content=["']([^"']+)["']`,
      "iu"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["'](?:${alternation})["']`,
      "iu"
    ),
  ];
  for (const pattern of patterns) {
    const value = cleanMetadataText(source.match(pattern)?.[1]);
    if (value) return value;
  }
  return null;
}

/**
 * Google Maps URLと現在のHTML埋め込み値から、識別子と人間向け地点情報を得る。
 * `0x...:0x...` はPlaces APIのPlace IDではなくMaps Feature IDなので区別する。
 */
export function extractGoogleMapsPlaceMetadata(
  source: string
): GoogleMapsPlaceMetadata {
  const normalized = normalizeGoogleMapsText(source);
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(normalized.trim());
  } catch {
    // HTMLやJSON文字列は下のパターンで処理する。
  }

  const parameterPlaceId = parsedUrl
    ? [
        "query_place_id",
        "destination_place_id",
        "origin_place_id",
        "place_id",
        "placeid",
      ]
        .map((name) => validPlacesApiId(parsedUrl?.searchParams.get(name)))
        .find((value): value is string => Boolean(value)) ?? null
    : null;
  const embeddedPlaceId = validPlacesApiId(
    normalized.match(
      /["'](?:placeId|place_id)["']\s*:\s*["']([^"']+)["']/iu
    )?.[1] ??
      normalized.match(/!(?:1|2|3)s(ChI[A-Za-z0-9_-]{8,})/u)?.[1]
  );
  const placeId = parameterPlaceId ?? embeddedPlaceId;

  const featureId =
    googleMapsFeatureId(parsedUrl?.searchParams.get("ftid")) ??
    googleMapsFeatureId(normalized);
  const explicitCid = parsedUrl?.searchParams.get("cid")?.trim() ?? null;
  const cid = /^\d{3,30}$/u.test(explicitCid ?? "")
    ? explicitCid
    : featureIdCid(featureId);

  const placeQuery = extractGoogleMapsPlaceQuery(normalized);
  const queryCandidates = placeQuery
    ? placeQuery
        .replace(/^〒?\d{3}-?\d{4}\s*/u, "")
        .split(/\s+/u)
        .filter(Boolean)
    : [];
  const pathName = cleanMetadataText(queryCandidates.at(-1));
  const htmlName = htmlMetadataValue(normalized, ["og:title", "twitter:title", "name"]);
  const htmlAddress =
    htmlMetadataValue(normalized, ["address", "formattedAddress"]) ??
    cleanMetadataText(
      normalized.match(
        /["'](?:formattedAddress|formatted_address|address)["']\s*:\s*["']([^"']+)["']/iu
      )?.[1]
    );

  return {
    placeId: placeId ?? featureId ?? (/^\d{3,30}$/u.test(explicitCid ?? "") ? explicitCid : null),
    placeIdType: placeId
      ? "places-api"
      : featureId
        ? "maps-feature-id"
        : /^\d{3,30}$/u.test(explicitCid ?? "")
          ? "cid"
          : null,
    googleMapsFeatureId: featureId,
    cid,
    placeQuery,
    placeName: htmlName ?? pathName,
    formattedAddress: htmlAddress,
  };
}

export function extractGoogleMapsCoordinates(
  source: string
): GoogleMapsCoordinates | null {
  const normalized = normalizeGoogleMapsText(source);

  const urlCoordinates = extractCoordinatesFromUrl(normalized);
  if (urlCoordinates) return urlCoordinates;

  const latitudeLongitudePatterns = [
    // placeの正式座標を、画面中心を表す@座標より優先する。
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/u,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/u,
    /[?&](?:query|q|destination|ll)=(-?\d+(?:\.\d+)?),(?:\+|\s)*(-?\d+(?:\.\d+)?)/iu,
    /"latitude"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/iu,
    /["'](?:latitude|lat)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)[\s\S]{0,160}?["'](?:longitude|lng|lon)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)/iu,
  ];
  for (const pattern of latitudeLongitudePatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const coordinates = coordinatePair(match[1], match[2]);
    if (coordinates) return coordinates;
  }

  // JSONのキーがlongitude→latitudeの順で返る共有ページにも対応する。
  const namedLongitudeLatitude = normalized.match(
    /["'](?:longitude|lng|lon)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)[\s\S]{0,160}?["'](?:latitude|lat)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)/iu
  );
  if (namedLongitudeLatitude) {
    const coordinates = coordinatePair(
      namedLongitudeLatitude[2],
      namedLongitudeLatitude[1]
    );
    if (coordinates) return coordinates;
  }

  // 一部のGoogle Maps dataパラメーターは経度(!2d)→緯度(!3d)の順で格納される。
  const longitudeLatitude = normalized.match(
    /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/u
  );
  if (longitudeLatitude) {
    const coordinates = coordinatePair(
      longitudeLatitude[2],
      longitudeLatitude[1]
    );
    if (coordinates) return coordinates;
  }

  // URLへ座標を含めない共有形式は、Google Maps初期化データ内の
  // [null,null,latitude,longitude] を対象地点または表示中心として返す。
  const initializationIndex = normalized.indexOf("APP_INITIALIZATION_STATE");
  if (initializationIndex >= 0) {
    const initializationState = normalized.slice(
      initializationIndex,
      initializationIndex + 750_000
    );
    const initializationCoordinates = initializationState.match(
      /\[\s*null\s*,\s*null\s*,\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*\]/u
    );
    if (initializationCoordinates) {
      return coordinatePair(
        initializationCoordinates[1],
        initializationCoordinates[2]
      );
    }
  }

  return null;
}
