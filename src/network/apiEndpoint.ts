import { Capacitor } from "@capacitor/core";

export const PUBLIC_ASTROSIGHT_ORIGIN = "https://astrosight.pages.dev";

/**
 * PWA/Web版は同一オリジンのPages Functionsを使う。
 * Capacitor版のオリジンは https://localhost のため、相対 /api を使うと
 * 同梱index.htmlが返る。ネイティブ版だけ公開Pages APIへ明示的に接続する。
 */
export function apiEndpoint(
  path: string,
  nativePlatform = Capacitor.isNativePlatform()
): string {
  if (!path.startsWith("/")) throw new Error("API path must start with /");
  if (nativePlatform) {
    return new URL(path, PUBLIC_ASTROSIGHT_ORIGIN).toString();
  }
  return path;
}
