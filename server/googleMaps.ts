import {
  extractGoogleMapsCoordinates,
  extractGoogleMapsSharedUrl,
  isAllowedGoogleMapsHost,
} from "../src/search/googleMapsUrl.ts";

export type ResolvedGoogleMapsLocation = {
  latitude: number;
  longitude: number;
  resolvedUrl: string;
};

const GOOGLE_REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
} as const;

// WHATWG Fetch標準のHTTP redirect countと同じ値にし、
// 手動解析と標準fetchで異なる上限を持たないようにする。
const MAX_REDIRECT_HOPS = 20;

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#x22;", '"')
    .replaceAll("\\u003d", "=")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\u002f", "/")
    .replaceAll("\\/", "/");
}

function resolveRedirectUrl(location: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(decodeHtmlEntities(location), baseUrl);
    // Google共有リンクの解析中に外部サイトへ誘導されないよう転送先も制限する。
    return isAllowedGoogleMapsHost(resolved.hostname) ? resolved.href : null;
  } catch {
    return null;
  }
}

function extractGoogleUrlsFromHtml(
  html: string,
  baseUrl: string,
  includeOrdinaryLinks = true
): string[] {
  const decoded = decodeHtmlEntities(html);
  const values = new Set<string>();

  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    const resolved = resolveRedirectUrl(candidate, baseUrl);
    if (!resolved) return;
    try {
      const hostname = new URL(resolved).hostname.toLowerCase();
      if (
        hostname === "maps.app.goo.gl" ||
        hostname === "goo.gl" ||
        hostname === "google.com" ||
        hostname.endsWith(".google.com") ||
        hostname === "google.co.jp" ||
        hostname.endsWith(".google.co.jp")
      ) {
        values.add(resolved);
      }
    } catch {
      // 不正な候補は無視する。
    }
  };

  // 転送先として信頼できるcanonical / Open Graph / meta refreshを先に回収する。
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/giu,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/giu,
    /<meta[^>]+(?:property|name)=["'](?:og:url|twitter:url)["'][^>]+content=["']([^"']+)["']/giu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:url|twitter:url)["']/giu,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"';]+)[^"']*["']/giu,
  ];
  if (includeOrdinaryLinks) {
    // 座標の抽出時だけ通常リンクも調べる。次の転送先には使用しない。
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

function coordinatesFromContent(
  content: string,
  resolvedUrl: string
): ResolvedGoogleMapsLocation | null {
  const direct = extractGoogleMapsCoordinates(content);
  if (direct) return { ...direct, resolvedUrl };

  for (const candidate of extractGoogleUrlsFromHtml(content, resolvedUrl)) {
    const coordinates = extractGoogleMapsCoordinates(candidate);
    if (coordinates) return { ...coordinates, resolvedUrl: candidate };
  }
  return null;
}

export async function resolveGoogleMapsSharedUrl(
  input: string
): Promise<ResolvedGoogleMapsLocation> {
  const sourceUrl = extractGoogleMapsSharedUrl(input);
  if (!sourceUrl) throw new Error("Googleマップの共有URLではありません");

  const direct = extractGoogleMapsCoordinates(sourceUrl);
  if (direct) return { ...direct, resolvedUrl: sourceUrl };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 18_000);
  try {
    let currentUrl = sourceUrl;
    const visited = new Set<string>();

    // 自動リダイレクトに任せずLocationを段階的に確認する。
    // maps.app.goo.glの仕様変更や途中の同意ページにも対応しやすくする。
    // 地域・言語・同意画面を経由する共有URLに備えて上限を拡張する。
    // 通常のページ内リンクは転送先に選ばないため、無関係なGoogleページを巡回しない。
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      if (visited.has(currentUrl)) throw new Error("共有リンクが循環しています");
      visited.add(currentUrl);

      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: abortController.signal,
        headers: GOOGLE_REQUEST_HEADERS,
      });

      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        const nextUrl = resolveRedirectUrl(location, currentUrl);
        if (!nextUrl) throw new Error("転送先URLを読み取れませんでした");
        const fromLocation = extractGoogleMapsCoordinates(nextUrl);
        if (fromLocation) return { ...fromLocation, resolvedUrl: nextUrl };
        currentUrl = nextUrl;
        continue;
      }

      const responseText = await response.text();
      const fromResponse = coordinatesFromContent(responseText, currentUrl);
      if (fromResponse) return fromResponse;

      // 200応答のHTML内に次のGoogle Maps URLが埋め込まれる形式にも対応する。
      const nextCandidates = extractGoogleUrlsFromHtml(
        responseText,
        currentUrl,
        false
      ).filter((candidate) => !visited.has(candidate));
      const coordinateCandidate = nextCandidates.find((candidate) =>
        extractGoogleMapsCoordinates(candidate)
      );
      if (coordinateCandidate) {
        const coordinates = extractGoogleMapsCoordinates(coordinateCandidate);
        if (coordinates) return { ...coordinates, resolvedUrl: coordinateCandidate };
      }
      const nextCandidate = nextCandidates.find((candidate) => candidate !== currentUrl);
      if (nextCandidate) {
        currentUrl = nextCandidate;
        continue;
      }

      throw new Error(
        response.ok
          ? "共有リンクは開けましたが座標を取得できませんでした"
          : `Googleマップ共有リンク通信エラー：${response.status}`
      );
    }
    // 手動転送で確定しない特殊な共有リンクは、fetch標準の転送処理で最終URLを確認する。
    const finalResponse = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
      headers: GOOGLE_REQUEST_HEADERS,
    });
    const finalUrl = finalResponse.url || sourceUrl;
    const finalUrlCoordinates = extractGoogleMapsCoordinates(finalUrl);
    if (finalUrlCoordinates) {
      return { ...finalUrlCoordinates, resolvedUrl: finalUrl };
    }
    const finalContent = await finalResponse.text();
    const finalCoordinates = coordinatesFromContent(finalContent, finalUrl);
    if (finalCoordinates) return finalCoordinates;
    throw new Error("共有リンクの最終転送先から座標を取得できませんでした");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Googleマップ共有リンクの解析がタイムアウトしました");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
