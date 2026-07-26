export type GoogleMapsCoordinates = {
  latitude: number;
  longitude: number;
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

export function extractGoogleMapsSharedUrl(text: string): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const candidate of candidates) {
    // 共有文と一緒に貼られた末尾の日本語句読点や括弧をURLから除外する。
    const cleaned = candidate.replace(/[\])}】）」』、。,]+$/gu, "");
    try {
      const url = new URL(cleaned);
      if (isAllowedGoogleMapsHost(url.hostname)) return url.href;
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
    /[?&](?:query|q|destination|ll|center)=(-?\d+(?:\.\d+)?),(?:\+|\s)*(-?\d+(?:\.\d+)?)/iu,
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
