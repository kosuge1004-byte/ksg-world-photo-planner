/**
 * 2026-09-30: Eドライブで計算した方位プロファイルをR2へ書き戻す。
 *
 * 以前はEドライブの計算結果をその場で返すだけで保存しなかったため、同じ座標を
 * 別の機会・別の利用者がダウンロードするたびに自宅PCで再計算していた（PC停止中は
 * 以前計算できた座標でも失敗）。一度計算した結果をR2に置き、次回からはR2で返す。
 *
 * - 対象は登録スポット以外（登録スポットは公開済みの計算済みファイルが正）。
 * - キーは「座標（小数7桁）＋探索距離＋要求方位の集合」。要求方位が異なる要求
 *   とは共有しない（部分集合の取り違えを構造的に防ぐ）。
 * - 値はEドライブ応答のJSON文字列そのもの。Workerで再圧縮・再解析しない
 *   （無料プランのCPU時間を使わない）。端末側は従来どおり全方位・全距離を検証する。
 * - 書き込みはR2安全予算（月間書込・容量予約）の範囲内だけで行う。
 */
import type {
  BearingProfileBatchRequest,
  BearingProfileBatchResponseV2,
} from "../src/types/bearingProfileBatch.ts";
import { keepServerTaskAlive, serverPersistentCache } from "./cloudflareRuntime.ts";
import { precomputedBearingProfileIdentity } from "./precomputedBearingProfiles.ts";
import { EDRIVE_PROFILE_WRITE_BACK_PREFIX } from "./r2SafetyBudget.ts";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function edriveProfileWriteBackKey(request: BearingProfileBatchRequest): Promise<string> {
  const identity = precomputedBearingProfileIdentity({
    latitude: request.subjectPoint.latitude,
    longitude: request.subjectPoint.longitude,
    maxDistanceMeters: request.maxDistanceMeters,
  });
  const bearings = [...new Set(request.bearings)].sort((a, b) => a - b).join(",");
  return `${EDRIVE_PROFILE_WRITE_BACK_PREFIX}${await sha256Hex(`${identity}|${bearings}`)}.json`;
}

/** 書き戻し済みのJSONバイト列（未解析）。無ければnull。 */
export async function readEdriveProfileWriteBack(
  request: BearingProfileBatchRequest
): Promise<ArrayBuffer | null> {
  const cache = serverPersistentCache();
  if (!cache) return null;
  const key = await edriveProfileWriteBackKey(request);
  const read = cache.getWithStatus
    ? await cache.getWithStatus(key, { type: "arrayBuffer" })
    : { status: "hit" as const, value: await cache.get(key, { type: "arrayBuffer" }) };
  if (read.status !== "hit" || !(read.value instanceof ArrayBuffer) || read.value.byteLength === 0) {
    return null;
  }
  return read.value;
}

/** 完全な（失敗方位のない）Eドライブ結果だけを、応答後にR2へ保存する。 */
export function scheduleEdriveProfileWriteBack(
  request: BearingProfileBatchRequest,
  response: BearingProfileBatchResponseV2,
  jsonText: string
): void {
  if (response.failedBearings.length !== 0) return;
  if (response.requestedBearingCount !== request.bearings.length) return;
  const cache = serverPersistentCache();
  if (!cache) return;
  keepServerTaskAlive((async () => {
    const key = await edriveProfileWriteBackKey(request);
    const bytes = new TextEncoder().encode(jsonText);
    await cache.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  })().catch(() => {
    // 保存失敗は応答に影響させない（次回はEドライブで再計算）。
  }));
}
