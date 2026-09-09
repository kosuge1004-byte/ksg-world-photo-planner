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
  const coarse = await sampleServerWorldTerrain(
    cartographicPoints.map(({ destination }) =>
      Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
    ),
    signal,
    cartographicPoints.map(() => "10m")
  );
  let precise = coarse;
  try {
    precise = await sampleServerWorldTerrain(
      cartographicPoints.map(({ destination }) =>
        Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
      ),
      signal,
      cartographicPoints.map(() => "1m")
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

  for (let index = 0; index < pendingBearings.length; index += 1) {
    const bearing = pendingBearings[index];
    try {
      const profile = await computeBearingProfile(subjectPoint, bearing, undefined);
      profiles.push(profile);
      // 端末版と同じく、各方位から均等に8点だけ水面判定の対象として抽出する。
      const stride = Math.max(1, Math.floor(profile.points.length / 8));
      for (let i = 0; i < profile.points.length; i += stride) {
        waterPrefetchPoints.push({
          latitude: profile.points[i].latitude,
          longitude: profile.points[i].longitude,
        });
      }
    } catch (error) {
      // 1方位の失敗で全体を止めない。端末版のconsole.warnと同じ位置づけ。
      console.warn(`[bearing-profile-download-job] 方位${bearing}°の地形取得に失敗しました`, error);
    }
    await updateJob({
      progress: `地形プロファイルを取得しています（${index + 1}/${pendingBearings.length}方位）`,
      progressPercent: Math.round(((index + 1) / pendingBearings.length) * 70),
    });
  }

  await updateJob({ progress: "水面・河川情報を確認しています", progressPercent: 75 });
  let waterSiteContexts: SiteContext[] = [];
  try {
    waterSiteContexts = await fetchServerSiteContexts(waterPrefetchPoints, undefined, false);
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
    fullSiteContexts = await fetchServerSiteContexts(fullSiteContextPoints, undefined, true);
  } catch (error) {
    console.warn("[bearing-profile-download-job] 被写体周辺情報の取得に失敗しました", error);
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
