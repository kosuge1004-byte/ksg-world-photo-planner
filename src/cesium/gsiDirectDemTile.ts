import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  decodeGsiDemPngAsync,
  type DecodedGsiDemTile,
} from "../../server/gsiDemPng.ts";
import { createAbortError, createTimeoutError } from "../utils/runtimeErrors";

/**
 * 2026-09-30: 国土地理院の標高PNGタイルを端末から直接取得・デコードする。
 *
 * 三脚候補・三脚ピン・周辺データ保存の地形取得が Cloudflare Pages Functions
 * の単一経路に依存していたため、サーバー側で1か所詰まると全機能が同時に
 * 止まっていた。タイルPNGそのものは国土地理院が公開しており、サーバーが
 * 行っていたのは「取得→デコード→補間」だけである。デコーダは
 * server/gsiDemPng.ts をサーバーと共有するため、得られるcm整数配列は
 * サーバー経路と完全に同一。補間は既存の端末タイルキャッシュ
 * （gsiDemTileCache.ts）がサーバーと同じ式で行う。
 *
 * Cloudflareの無料枠（Functions呼び出し数・サブリクエスト数・R2操作）を
 * 一切消費しない。
 */

export type DirectDemSource = { id: string; zoom: number };
export type DirectDemTileResult = { kind: "empty" } | { kind: "data"; tile: DecodedGsiDemTile };

const DIRECT_TILE_TIMEOUT_MS = 10_000;

function tileUrl(source: DirectDemSource, x: number, y: number): string {
  return `https://cyberjapandata.gsi.go.jp/xyz/${source.id}/${source.zoom}/${x}/${y}.png`;
}

async function inflateWithDecompressionStream(compressed: Uint8Array): Promise<Uint8Array> {
  const DecompressionStreamCtor = (globalThis as unknown as {
    DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array>;
  }).DecompressionStream;
  if (!DecompressionStreamCtor) {
    throw new Error("この端末はPNG展開（DecompressionStream）に対応していません");
  }
  // PNG IDAT はzlib形式（RFC1950）であり、DecompressionStreamの "deflate" が対応する。
  const exact = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength
  ) as ArrayBuffer;
  const stream = new Blob([exact]).stream().pipeThrough(new DecompressionStreamCtor("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type RawResponse = { status: number; bytes: Uint8Array | null };

async function fetchWithWebView(url: string, signal: AbortSignal): Promise<RawResponse> {
  const response = await fetch(url, { signal, headers: { Accept: "image/png" } });
  if (response.status === 404) return { status: 404, bytes: null };
  if (!response.ok) return { status: response.status, bytes: null };
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function fetchWithNativeHttp(url: string): Promise<RawResponse> {
  // WebViewのCORS判定を受けないネイティブHTTP。WebView fetchが通信レベルで
  // 失敗したAndroid/iOSでだけ使う（Capacitor Core同梱、追加依存なし）。
  const response = await CapacitorHttp.request({
    url,
    method: "GET",
    responseType: "arraybuffer",
    headers: { Accept: "image/png" },
    connectTimeout: DIRECT_TILE_TIMEOUT_MS,
    readTimeout: DIRECT_TILE_TIMEOUT_MS,
  });
  if (response.status === 404) return { status: 404, bytes: null };
  if (response.status < 200 || response.status >= 300) return { status: response.status, bytes: null };
  const data = response.data as unknown;
  if (typeof data === "string") return { status: response.status, bytes: base64ToBytes(data) };
  if (data instanceof ArrayBuffer) return { status: response.status, bytes: new Uint8Array(data) };
  throw new Error("ネイティブHTTPの応答形式が不正です");
}

let nativeHttpPreferred = false;

/**
 * 1タイルを国土地理院から直接取得してデコードする。
 * 404は「このDEMソースにデータが無い」確定結果（empty）。それ以外の失敗は
 * 例外として返し、呼び出し側がNoDataと混同しないようにする。
 */
export async function fetchGsiDemTileDirect(
  source: DirectDemSource,
  x: number,
  y: number,
  signal?: AbortSignal
): Promise<DirectDemTileResult> {
  if (signal?.aborted) throw createAbortError("標高取得を中止しました");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(createTimeoutError("国土地理院標高タイルの直接取得がタイムアウトしました")),
    DIRECT_TILE_TIMEOUT_MS
  );
  const onAbort = () => controller.abort(createAbortError("標高取得を中止しました"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const url = tileUrl(source, x, y);
    let raw: RawResponse;
    if (nativeHttpPreferred && Capacitor.isNativePlatform()) {
      raw = await fetchWithNativeHttp(url);
    } else {
      try {
        raw = await fetchWithWebView(url, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || !Capacitor.isNativePlatform()) throw error;
        // TypeError（CORS・証明書・WebView制限など通信レベル失敗）だけネイティブへ。
        raw = await fetchWithNativeHttp(url);
        nativeHttpPreferred = true;
      }
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    if (raw.status === 404) return { kind: "empty" };
    if (!raw.bytes) throw new Error(`国土地理院標高タイル取得エラー：${raw.status}`);
    const tile = await decodeGsiDemPngAsync(raw.bytes, inflateWithDecompressionStream);
    return { kind: "data", tile };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
