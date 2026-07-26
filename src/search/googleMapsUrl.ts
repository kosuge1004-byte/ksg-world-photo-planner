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

export function extractGoogleMapsCoordinates(
  source: string
): GoogleMapsCoordinates | null {
  let normalized = source
    .replaceAll("\\u003d", "=")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // URL全体をデコードできない場合も未デコード文字列のパターンを調べる。
  }

  const urlCoordinates = extractCoordinatesFromUrl(normalized);
  if (urlCoordinates) return urlCoordinates;

  const latitudeLongitudePatterns = [
    // placeの正式座標を、画面中心を表す@座標より優先する。
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/u,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/u,
    /[?&](?:query|q|destination|ll|center)=(-?\d+(?:\.\d+)?),(?:\+|\s)*(-?\d+(?:\.\d+)?)/iu,
    /"latitude"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/iu,
  ];
  for (const pattern of latitudeLongitudePatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const coordinates = coordinatePair(match[1], match[2]);
    if (coordinates) return coordinates;
  }

  // 一部のGoogle Maps dataパラメーターは経度(!2d)→緯度(!3d)の順で格納される。
  const longitudeLatitude = normalized.match(
    /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/u
  );
  return longitudeLatitude
    ? coordinatePair(longitudeLatitude[2], longitudeLatitude[1])
    : null;
}
