import {
  extractGoogleMapsCoordinates,
  extractGoogleMapsSharedUrl,
} from "../src/search/googleMapsUrl.ts";

export type ResolvedGoogleMapsLocation = {
  latitude: number;
  longitude: number;
  resolvedUrl: string;
};

export async function resolveGoogleMapsSharedUrl(
  input: string
): Promise<ResolvedGoogleMapsLocation> {
  const sourceUrl = extractGoogleMapsSharedUrl(input);
  if (!sourceUrl) throw new Error("Googleマップの共有URLではありません");

  const direct = extractGoogleMapsCoordinates(sourceUrl);
  if (direct) return { ...direct, resolvedUrl: sourceUrl };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 12_000);
  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 KSG-World-Photo-Planner/1.0",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.8",
      },
    });
    const resolvedUrl = response.url || sourceUrl;
    const fromRedirect = extractGoogleMapsCoordinates(resolvedUrl);
    if (fromRedirect) return { ...fromRedirect, resolvedUrl };

    // Googleが座標を最終URLではなくHTML/埋め込みJSONへ格納する場合にも対応する。
    const responseText = await response.text();
    const fromBody = extractGoogleMapsCoordinates(responseText);
    if (fromBody) return { ...fromBody, resolvedUrl };
    throw new Error(
      response.ok
        ? "共有リンクは開けましたが座標を取得できませんでした"
        : `Googleマップ共有リンク通信エラー：${response.status}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
