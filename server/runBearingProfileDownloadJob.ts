import { Cartographic } from "cesium";
import {
  ABSOLUTE_MAX_DISTANCE_METERS,
  ABSOLUTE_MIN_DISTANCE_METERS,
  ADAPTIVE_COARSE_MAX_SPAN_METERS,
  densifyDistanceIntervals,
  logarithmicDistances,
} from "../src/cesium/tripodCandidates.ts";
import { calculateKarneyDestinationPoint } from "../src/geodesy/karneyGeodesic.ts";
import type {
  BearingProfileDownloadJob,
  SerializedBearingProfileEntry,
  SerializedSiteContextPoint,
} from "../src/types/backgroundBearingProfile.ts";
import type { SiteContext } from "../src/types/geospatial.ts";
import type { GroundPoint } from "../src/types/points.ts";
import { sampleServerWorldTerrain } from "./worldTerrain.ts";
import { fetchServerSiteContexts } from "./siteContext.ts";

/**
 * 2026-09-09追記（実機での動作確認で判明した不具合の修正）: サーバー側の
 * 地形・OSM取得処理にタイムアウトが一切無く、外部API（国土地理院/
 * Overpass）への通信がハングした場合、ジョブ全体が永遠に進まなくなって
 * いた。これはまさにクライアント側で2026-09-08に修正した「0°で停止する」
 * 不具合と同じ種類の問題を、サーバー側へそのまま持ち込んでしまっていた。
 * 1方位・1回の外部API呼び出しあたりに上限時間を設け、ハングしても
 * 必ずタイムアウトして次へ進むようにする。
 */
const EXTERNAL_CALL_TIMEOUT_MS = 45_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${timeoutMessage}（${Math.round(EXTERNAL_CALL_TIMEOUT_MS / 1000)}秒でタイムアウト）`));
    }, EXTERNAL_CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * 2026-09-08追記: src/cache/tripodBearingProfileManager.tsのbackfillBearing
 * Profilesと同じ距離配列・同じ密度規則をサーバー側で再現する。座標列・
 * DEM詳細度（10m粗探索→1m高精度読み取り用の実測値保存）は端末版と一切
 * 変更しない。読み出し側（tryUseBearingProfileCache）は必ずライブで
 * cm精度を取り直すため、ここで保存する値はあくまで「どのあたりに交点が
 * ありうるか」のブラケット検出用（tryUseBearingProfileCache冒頭コメント
 * 参照）。
 */
const baseDistances = densifyDistanceIntervals(
  logarithmicDistances(
    { minMeters: ABSOLUTE_MIN_DISTANCE_METERS, maxMeters: ABSOLUTE_MAX_DISTANCE_METERS },
    32
  ),
  ADAPTIVE_COARSE_MAX_SPAN_METERS
);

async function computeBearingProfile(
  subjectPoint: GroundPoint,
  bearing: number,
  signal: AbortSignal | undefined
): Promise<SerializedBearingProfileEntry> {
  const cartographicPoints = baseDistances.map((distanceMeters) => {
    const destination = calculateKarneyDestinationPoint(subjectPoint, bearing, distanceMeters);
    return { distanceMeters, destination };
  });
  // 端末版と同じく、まず10m粗探索で地形の概形を取得し、続けて1mの高精度値で
  // 上書きする。1m取得が失敗した場合は10m値をそのまま使う（端末版のcatch節と
  // 同じフォールバック方針）。
  const coarse = await withTimeout(
    sampleServerWorldTerrain(
      cartographicPoints.map(({ destination }) =>
        Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
      ),
      signal,
      cartographicPoints.map(() => "10m")
    ),
    `方位${bearing}°の10m地形取得`
  );
  let precise = coarse;
  try {
    precise = await withTimeout(
      sampleServerWorldTerrain(
        cartographicPoints.map(({ destination }) =>
          Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
        ),
        signal,
        cartographicPoints.map(() => "1m")
      ),
      `方位${bearing}°の1m高精度地形取得`
    );
  } catch {
    // 端末版と同じベストエフォート方針: 高精度取得に失敗しても10m値で継続する。
  }
  return {
    bearingDegrees: bearing,
    points: cartographicPoints.map(({ distanceMeters, destination }, index) => ({
      distanceMeters,
      longitude: destination.longitude,
      latitude: destination.latitude,
      ellipsoidalHeightMeters: precise[index]?.height ?? coarse[index]?.height ?? 0,
    })),
    computedAtIso: new Date().toISOString(),
  };
}

export async function runBearingProfileDownloadJob(
  job: BearingProfileDownloadJob,
  updateJob: (update: Partial<Pick<
    BearingProfileDownloadJob,
    "status" | "progress" | "progressPercent" | "profiles" |
    "waterSiteContextPoints" | "waterSiteContexts" |
    "fullSiteContextPoints" | "fullSiteContexts" | "error"
  >>) => Promise<BearingProfileDownloadJob>
): Promise<void> {
  await updateJob({ status: "running", progress: "地形プロファイルを取得しています", progressPercent: 0 });

  const { subjectPoint, pendingBearings } = job.input;
  const profiles: SerializedBearingProfileEntry[] = [];
  const waterPrefetchPoints: SerializedSiteContextPoint[] = [];
  // 2026-09-09追記: 各方位の地形取得は互いに完全に独立しているにもかかわらず、
  // 従来は1方位ずつ直列に処理していたため、実際に転送されるデータ量
  // （方位あたり数十バイト）に対して不釣り合いに長い時間がかかっていた。
  // GSI側の同時実行数はsrc/cesium/gsiElevationClient.tsのsharedQueueが
  // モジュール単位でグローバルに10並列へ制限しているため、方位側をこれより
  // 多めに並行起動しても、実際のGSIへの同時リクエスト数はそちらで
  // 安全に頭打ちになる。よってBEARING_CONCURRENCY件を並行実行し、
  // 常にGSI側のキューを満杯に保つことで待ち時間を最小化する。
  const BEARING_CONCURRENCY = 16;
  // 2026-09-09追記: システム的な障害（GSI API全断など）で全方位が延々と
  // 失敗し続け、最終的に「空のデータで完了」という嘘の成功報告を出すことが
  // ないよう、早期の失敗が続いた場合は明示的に失敗させる。並行実行のため
  // 「連続」ではなく「最初のFAILURE_ABORT_THRESHOLD件の結果が出揃うまでに
  // 1件も成功しない」ことをシステム障害の兆候として扱う。
  const FAILURE_ABORT_THRESHOLD = 8;
  let successCount = 0;
  let failureCount = 0;
  let completedCount = 0;
  let abortReason: string | null = null;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (abortReason) return;
      const index = nextIndex;
      if (index >= pendingBearings.length) return;
      nextIndex += 1;
      const bearing = pendingBearings[index];
      try {
        const profile = await computeBearingProfile(subjectPoint, bearing, undefined);
        profiles.push(profile);
        successCount += 1;
        // 端末版と同じく、各方位から均等に8点だけ水面判定の対象として抽出する。
        const stride = Math.max(1, Math.floor(profile.points.length / 8));
        for (let i = 0; i < profile.points.length; i += stride) {
          waterPrefetchPoints.push({
            latitude: profile.points[i].latitude,
            longitude: profile.points[i].longitude,
          });
        }
      } catch (error) {
        // 孤立した失敗では全体を止めない。端末版のconsole.warnと同じ位置づけ。
        failureCount += 1;
        console.warn(`[bearing-profile-download-job] 方位${bearing}°の地形取得に失敗しました`, error);
        if (successCount === 0 && failureCount >= FAILURE_ABORT_THRESHOLD && !abortReason) {
          abortReason = `最初の${failureCount}方位が1件も成功しなかったため中止しました（${error instanceof Error ? error.message : String(error)}）`;
        }
      }
      completedCount += 1;
      await updateJob({
        progress: `地形プロファイルを取得しています（${completedCount}/${pendingBearings.length}方位）`,
        progressPercent: Math.round((completedCount / pendingBearings.length) * 70),
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BEARING_CONCURRENCY, pendingBearings.length) }, () => worker())
  );

  if (abortReason) {
    await updateJob({
      status: "failed",
      progress: "地形データの取得が繰り返し失敗したため中止しました",
      progressPercent: 0,
      error: abortReason,
    });
    return;
  }

  await updateJob({ progress: "水面・河川情報を確認しています", progressPercent: 75 });
  let waterSiteContexts: SiteContext[] = [];
  try {
    waterSiteContexts = await withTimeout(
      fetchServerSiteContexts(waterPrefetchPoints, undefined, false),
      "水面・河川情報の取得"
    );
  } catch (error) {
    console.warn("[bearing-profile-download-job] 水面・河川情報の取得に失敗しました", error);
  }

  await updateJob({ progress: "被写体周辺の情報を確認しています", progressPercent: 85 });
  const fullSiteContextPoints: SerializedSiteContextPoint[] = [
    { latitude: subjectPoint.latitude, longitude: subjectPoint.longitude },
  ];
  for (const radius of [25, 100]) {
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const destination = calculateKarneyDestinationPoint(subjectPoint, bearing, radius);
      fullSiteContextPoints.push({ latitude: destination.latitude, longitude: destination.longitude });
    }
  }
  let fullSiteContexts: SiteContext[] = [];
  try {
    fullSiteContexts = await withTimeout(
      fetchServerSiteContexts(fullSiteContextPoints, undefined, true),
      "被写体周辺情報の取得"
    );
  } catch (error) {
    console.warn("[bearing-profile-download-job] 被写体周辺情報の取得に失敗しました", error);
  }

  // 2026-09-09追記: pendingBearings件数が少なく（5件未満）、連続失敗の早期
  // 中止しきい値に届かないまま全滅した場合の保険。1方位も取得できて
  // いないのに「保存が完了しました」と報告することは絶対に避ける。
  if (profiles.length === 0) {
    await updateJob({
      status: "failed",
      progress: "地形データを1方位も取得できなかったため中止しました",
      progressPercent: 0,
      error: "地形データを1方位も取得できませんでした。国土地理院APIへの接続状況をご確認ください。",
    });
    return;
  }

  await updateJob({
    status: "complete",
    progress: "完了しました",
    progressPercent: 100,
    profiles,
    waterSiteContextPoints: waterPrefetchPoints,
    waterSiteContexts,
    fullSiteContextPoints,
    fullSiteContexts,
  });
}
