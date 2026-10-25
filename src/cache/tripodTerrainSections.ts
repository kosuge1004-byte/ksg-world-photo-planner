import type { GroundPoint } from "../types/points";
import type { TerrainSection, TerrainSectionLookup } from "../cesium/tripodCandidateTerrainArc";
import { findPrecomputedBearingProfileTarget } from "../data/precomputedBearingProfileTargets";
import { idFor } from "../subjectStorage";
import {
  fetchBearingProfileBatch,
  fetchStaticPrecomputedTerrainProfile,
  type StaticPrecomputedTerrainProfile,
} from "./bearingProfileBatchClient";
import { listDownloadedSpotData } from "./downloadedSpotData";
import { getBearingProfilesMany, roundCameraHeightForCacheKey } from "./tripodBearingProfileCache";
import { isBearingProfileEnabled } from "./tripodBearingProfileManager";
import { localDemExactBearingBatchLimit } from "../../server/localDemProfileLimits.ts";

/**
 * 2026-10-08: 三脚候補線（標高を加味した線）に使う地形の断面の読み込み。
 *
 * 1度刻みの保存済み断面は従来の表示には利用できるが、赤線には最大0.5度の
 * 横ずれを生む。赤線は exact 取得元を使い、候補点と同じ小数方位をEドライブの
 * 全国DEMからまとめて計算する。
 *   device      : ダウンロード済みの地点。端末に保存した方位ごとの断面を読む（通信なし）。
 *   precomputed : 内蔵スポットで未ダウンロードの地点。配信済みの計算済みファイルを1回取得し、
 *                 表示用にメモリへ持つだけで端末には保存しない。
 *   exact       : 全国DEMから小数方位をまとめて取得する。取得できない場合は誤差のある線を出さない。
 */
export type TerrainSectionSource = "device" | "precomputed" | "exact";

/** 通信・保存領域を読まずに判定できる「この地点で使える見込みの取得元」。優先順。 */
export function terrainSectionSourcesFor(
  subject: Pick<GroundPoint, "latitude" | "longitude">
): TerrainSectionSource[] {
  const sources: TerrainSectionSource[] = [];
  const subjectId = idFor(subject as GroundPoint);
  // tryUseBearingProfileCache と同じ条件（有効化済み、または断面を保存したダウンロード記録がある）。
  if (
    isBearingProfileEnabled(subjectId) ||
    listDownloadedSpotData().some((record) => record.subjectId === subjectId && record.profilePoints > 0)
  ) sources.push("device");
  if (findPrecomputedBearingProfileTarget(subject.latitude, subject.longitude)) sources.push("precomputed");
  if (subject.latitude >= 20 && subject.latitude <= 46.5 &&
    subject.longitude >= 122 && subject.longitude <= 154) sources.push("exact");
  return sources;
}

const DEVICE_READ_BATCH_SIZE = 30;
let deviceCache: { key: string; sections: Map<number, TerrainSection> } | null = null;

async function loadDeviceSections(
  subject: GroundPoint,
  lensCenterHeightMeters: number,
  bearings: readonly number[],
  revision: string,
  signal: AbortSignal | undefined
): Promise<TerrainSectionLookup | null> {
  const subjectId = idFor(subject);
  const key = `${subjectId}|${roundCameraHeightForCacheKey(lensCenterHeightMeters)}|${revision}`;
  if (deviceCache?.key !== key) deviceCache = { key, sections: new Map() };
  const cache = deviceCache;
  const missing = bearings.filter((bearing) => !cache.sections.has(bearing));
  for (let start = 0; start < missing.length; start += DEVICE_READ_BATCH_SIZE) {
    if (signal?.aborted) return null;
    const batch = missing.slice(start, start + DEVICE_READ_BATCH_SIZE);
    const profiles = await getBearingProfilesMany(subjectId, lensCenterHeightMeters, batch);
    for (let index = 0; index < batch.length; index += 1) {
      const profile = profiles[index];
      // 1方位でも欠けていれば、その地点は断面が揃っていない（一部だけの線は出さない）。
      if (!profile || profile.points.length < 2) return null;
      // 保存形式は1点ごとのオブジェクト（緯度経度つき）。線の計算に要るのは距離と標高
      // だけなので、数値の配列へ詰め直して元のオブジェクトは手放す。
      const distancesMeters = new Float64Array(profile.points.length);
      const ellipsoidalHeightsMeters = new Float64Array(profile.points.length);
      profile.points.forEach((point, pointIndex) => {
        distancesMeters[pointIndex] = point.distanceMeters;
        ellipsoidalHeightsMeters[pointIndex] = point.ellipsoidalHeightMeters;
      });
      cache.sections.set(batch[index], { distancesMeters, ellipsoidalHeightsMeters });
    }
  }
  if (signal?.aborted) return null;
  return (bearing) => cache.sections.get(bearing) ?? null;
}

const PRECOMPUTED_CACHE_MAX_ENTRIES = 2;
const precomputedCache = new Map<string, Promise<StaticPrecomputedTerrainProfile | null>>();

async function loadPrecomputedSections(
  subject: GroundPoint,
  bearings: readonly number[],
  signal: AbortSignal | undefined
): Promise<TerrainSectionLookup | null> {
  const target = findPrecomputedBearingProfileTarget(subject.latitude, subject.longitude);
  if (!target) return null;
  const key = `${target.latitude.toFixed(7)},${target.longitude.toFixed(7)},${target.maxDistanceMeters}`;
  let pending = precomputedCache.get(key);
  if (!pending) {
    // 取得そのものは呼び出し元の中止に連動させない。日付や天体を切り替えて計算を
    // やり直すたびに、同じファイルの取得を最初からやり直さないため。
    pending = fetchStaticPrecomputedTerrainProfile({
      subjectPoint: { ...subject, latitude: target.latitude, longitude: target.longitude },
      maxDistanceMeters: target.maxDistanceMeters,
    }).catch(() => null);
    precomputedCache.set(key, pending);
    // 失敗（未配置・通信不良）は覚えない。次に必要になった時にもう一度試す。
    void pending.then((profile) => {
      if (!profile && precomputedCache.get(key) === pending) precomputedCache.delete(key);
    });
    while (precomputedCache.size > PRECOMPUTED_CACHE_MAX_ENTRIES) {
      const oldest = precomputedCache.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      precomputedCache.delete(oldest);
    }
  }
  const profile = await pending;
  if (!profile || signal?.aborted) return null;
  if (bearings.some((bearing) => !profile.heightsByBearing.has(bearing))) return null;
  return (bearing) => {
    const ellipsoidalHeightsMeters = profile.heightsByBearing.get(bearing);
    return ellipsoidalHeightsMeters
      ? { distancesMeters: profile.distancesMeters, ellipsoidalHeightsMeters }
      : null;
  };
}

let exactCache: { key: string; sections: Map<number, TerrainSection> } | null = null;

function exactBearingKey(bearing: number): number {
  return Math.round(bearing * 1_000_000) / 1_000_000;
}

async function loadExactSections(
  subject: GroundPoint,
  lensCenterHeightMeters: number,
  maxDistanceMeters: number,
  bearings: readonly number[],
  revision: string,
  signal: AbortSignal | undefined
): Promise<TerrainSectionLookup | null> {
  const key = `${idFor(subject)}|${maxDistanceMeters}|${revision}`;
  if (exactCache?.key !== key) exactCache = { key, sections: new Map() };
  const cache = exactCache;
  const normalizedBearings = [...new Set(bearings.map(exactBearingKey))];
  const missing = normalizedBearings.filter((bearing) => !cache.sections.has(bearing));
  const preferredBatchSize = localDemExactBearingBatchLimit(maxDistanceMeters, true);
  const safeBatchSize = localDemExactBearingBatchLimit(maxDistanceMeters, false);
  const queue: number[][] = [];
  for (let start = 0; start < missing.length; start += preferredBatchSize) {
    queue.push(missing.slice(start, start + preferredBatchSize));
  }

  while (queue.length > 0) {
    if (signal?.aborted) return null;
    const batch = queue.shift()!;
    const response = await fetchBearingProfileBatch({
      subjectPoint: subject,
      cameraSettings: { lensCenterHeightMeters },
      bearings: batch,
      maxDistanceMeters,
    }, signal);
    if (!response || response.failedBearings.length > 0 || response.profiles.length !== batch.length) {
      if (batch.length > safeBatchSize) {
        const split: number[][] = [];
        for (let start = 0; start < batch.length; start += safeBatchSize) {
          split.push(batch.slice(start, start + safeBatchSize));
        }
        queue.unshift(...split);
        continue;
      }
      return null;
    }
    const batchKeys = new Set(batch);
    const completed = new Map<number, TerrainSection>();
    for (const profile of response.profiles) {
      if (!profile.points || profile.points.length < 2) return null;
      const profileKey = exactBearingKey(profile.bearingDegrees);
      if (!batchKeys.has(profileKey) || completed.has(profileKey)) return null;
      const distancesMeters = new Float64Array(profile.points.length);
      const ellipsoidalHeightsMeters = new Float64Array(profile.points.length);
      profile.points.forEach((point, index) => {
        distancesMeters[index] = point.distanceMeters;
        ellipsoidalHeightsMeters[index] = point.ellipsoidalHeightMeters;
      });
      completed.set(profileKey, { distancesMeters, ellipsoidalHeightsMeters });
    }
    if (batch.some((bearing) => !completed.has(bearing))) return null;
    for (const [bearing, section] of completed) cache.sections.set(bearing, section);
  }
  if (normalizedBearings.some((bearing) => !cache.sections.has(bearing))) return null;
  return (bearing) => cache.sections.get(exactBearingKey(bearing)) ?? null;
}

/**
 * 必要な方位の断面をすべて揃えて返す。揃わなければnull。
 * revision はダウンロード済みデータの状態を表す文字列。ダウンロードの完了・更新・削除で
 * 変わる値を渡すと、端末から読み直す。
 */
export async function loadTerrainSectionLookup(input: {
  subject: GroundPoint;
  lensCenterHeightMeters: number;
  maxDistanceMeters: number;
  bearings: readonly number[];
  revision: string;
  signal?: AbortSignal;
}): Promise<{ source: TerrainSectionSource; lookup: TerrainSectionLookup } | null> {
  if (input.bearings.length === 0) return null;
  // 小数方位は1度保存データへ丸めない。exactが得られない場合は誤った赤線を
  // 出さずnullにして、候補点との不一致を見せない。
  const exactRequired = input.bearings.some((bearing) => !Number.isInteger(bearing));
  const sources = exactRequired
    ? (["exact"] as const)
    : terrainSectionSourcesFor(input.subject);
  for (const source of sources) {
    if (input.signal?.aborted) return null;
    const lookup = source === "exact"
      ? await loadExactSections(
          input.subject,
          input.lensCenterHeightMeters,
          input.maxDistanceMeters,
          input.bearings,
          input.revision,
          input.signal
        )
      : source === "device"
      ? await loadDeviceSections(
          input.subject, input.lensCenterHeightMeters, input.bearings, input.revision, input.signal
        )
      : await loadPrecomputedSections(input.subject, input.bearings, input.signal);
    if (lookup) return { source, lookup };
  }
  return null;
}

/** テスト用: メモリ上の断面を捨てる。 */
export function resetTerrainSectionMemoryForTests(): void {
  deviceCache = null;
  precomputedCache.clear();
  exactCache = null;
}
