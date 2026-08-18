// server/prewarmLandmarkCache.ts（CLI）と workers/prewarm-landmark-cron.ts
// （Cloudflare Cron Trigger）の両方から使う共通ロジック。
//
// 実際のUIから呼ばれるのと同じ calculateTripodCandidates を、代表的な
// 日時×天体の組み合わせで各ランドマークに対して実行する。通りがかった
// DEMタイル（本体・空判定）はR2へ書き込まれ、以降その付近を検索する
// 全ユーザーが恩恵を受ける（gsiElevation.tsのキャッシュと共通）。
//
// 国土地理院サーバーへ配慮し、ランドマーク間・リクエスト間に間隔を空けて
// 実行する（TrailNote等の既存実装が自主的に速度調整している方針にならう）。

import { calculateTripodCandidates, type TerrainSampler } from "../src/cesium/tripodCandidates.ts";
import { calculateCelestialHorizontalCoordinates } from "../src/cesium/celestial.ts";
import { sampleServerWorldTerrain } from "./worldTerrain.ts";
import type { PrewarmLandmark } from "./landmarkPrewarmSeed.ts";
import type { CelestialScreenPoint, CelestialBodyId } from "../src/types/celestial.ts";
import type { CameraSettings } from "../src/types/camera.ts";
import type { GroundPoint } from "../src/types/points.ts";

const CELESTIAL_IDS: CelestialBodyId[] = ["sun", "moon", "milkyWay", "polaris"];
const BODY_LABELS: Record<CelestialBodyId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
  polaris: "北極星",
};

// 季節差（太陽・天の川の見え方が大きく変わる）をカバーするための代表日時。
// 時刻は各天体がそれなりの高度に来やすい時間帯をおおまかに散らしている。
const SAMPLE_OFFSETS_DAYS = [0, 90, 180, 270]; // 四季をおおまかにカバー
const SAMPLE_HOURS = [6, 19, 22]; // 朝・夕方・深夜

const DEFAULT_CAMERA: CameraSettings = { focalLengthMm: 50, lensCenterHeightMeters: 1.5 };
export const REQUEST_DELAY_MS = 1500; // GSIサーバーへの配慮（1リクエストごとの間隔）
export const LANDMARK_DELAY_MS = 4000; // ランドマーク間の追加の間隔

const terrainSampler: TerrainSampler = (points, signal, maximumDetail) =>
  sampleServerWorldTerrain(points, signal, maximumDetail ? points.map(() => maximumDetail) : undefined);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildScreenPoint(
  id: CelestialBodyId,
  date: Date,
  subject: GroundPoint
): CelestialScreenPoint | null {
  const horizontal = calculateCelestialHorizontalCoordinates(id, date, subject, "standard");
  if (horizontal.altitudeDegrees <= 0) return null; // 地平線下は候補にならない
  return {
    id,
    label: BODY_LABELS[id],
    ...horizontal,
    xPercent: 50,
    yPercent: 50,
    visibleInFrame: true,
  };
}

export async function prewarmOne(
  landmark: PrewarmLandmark,
  log: (message: string) => void = () => {}
): Promise<{ attempts: number; candidatesFound: number }> {
  const subject: GroundPoint = {
    latitude: landmark.latitude,
    longitude: landmark.longitude,
    height: 0,
    label: landmark.name,
  };
  let attempts = 0;
  let candidatesFound = 0;

  for (const dayOffset of SAMPLE_OFFSETS_DAYS) {
    for (const hour of SAMPLE_HOURS) {
      const date = new Date();
      date.setDate(date.getDate() + dayOffset);
      date.setHours(hour, 0, 0, 0);

      const points = CELESTIAL_IDS
        .map((id) => buildScreenPoint(id, date, subject))
        .filter((point): point is CelestialScreenPoint => point !== null);
      if (points.length === 0) continue;

      attempts += 1;
      try {
        const candidates = await calculateTripodCandidates(
          subject,
          points,
          DEFAULT_CAMERA,
          date,
          "standard",
          terrainSampler
        );
        candidatesFound += candidates.length;
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
            : `非Errorオブジェクト: ${JSON.stringify(error)}`;
        log(`  ! ${landmark.name} ${date.toISOString()} 失敗: ${detail}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return { attempts, candidatesFound };
}

export async function prewarmMany(
  targets: PrewarmLandmark[],
  log: (message: string) => void = () => {}
): Promise<{ totalAttempts: number; totalCandidates: number }> {
  let totalAttempts = 0;
  let totalCandidates = 0;
  for (const [index, landmark] of targets.entries()) {
    log(`[${index + 1}/${targets.length}] ${landmark.name} を事前取得中...`);
    const result = await prewarmOne(landmark, log);
    totalAttempts += result.attempts;
    totalCandidates += result.candidatesFound;
    log(`  → ${result.attempts}回試行、候補${result.candidatesFound}件`);
    await sleep(LANDMARK_DELAY_MS);
  }
  return { totalAttempts, totalCandidates };
}

/**
 * 197件（今後増える見込み）を一度に処理すると1回の実行が長くなりすぎる
 * ため、日付ベースで自動的にローテーションする「今日の担当分」を返す。
 * KVへの状態保存は行わない（Workers KVへの書き込みを増やさない方針に
 * 合わせるため）。エポックからの経過日数を使い、chunkSize件ずつ順番に
 * 全件を巡回する。
 */
export function selectDailyChunk<T>(all: T[], chunkSize: number, referenceDate = new Date()): T[] {
  if (all.length === 0 || chunkSize <= 0) return [];
  const daysSinceEpoch = Math.floor(referenceDate.getTime() / 86_400_000);
  const totalChunks = Math.ceil(all.length / chunkSize);
  const chunkIndex = daysSinceEpoch % totalChunks;
  const start = chunkIndex * chunkSize;
  return all.slice(start, start + chunkSize);
}
