import type { CelestialOcclusion } from "../types/celestial";

export type OcclusionReasonPresentation = {
  state: "checking" | "blocked" | "unavailable";
  message: string;
};

export function presentCelestialOcclusionReason(
  occlusion: CelestialOcclusion
): OcclusionReasonPresentation | null {
  if (occlusion.verificationState === "checking") {
    return {
      state: "checking",
      message: "遮蔽を確認中です",
    };
  }
  if (occlusion.verificationState === "failed") {
    return {
      state: "unavailable",
      message: "遮蔽を確認できません",
    };
  }
  if (occlusion.terrainBoundaryUncertain) {
    return {
      state: "checking",
      message: "地形稜線との僅差のため遮蔽は未確定です",
    };
  }
  if (
    occlusion.reason === "below-horizon" &&
    occlusion.verificationState === "dem-and-google-3d"
  ) {
    return {
      state: "blocked",
      message: "地平線の下です",
    };
  }
  if (occlusion.reason === "terrain" && occlusion.terrainObstructed) {
    return {
      state: "blocked",
      message: "山や地形に隠れています",
    };
  }
  if (
    occlusion.verificationState === "dem-and-google-3d" &&
    occlusion.reason === "building-or-surface" &&
    occlusion.photorealisticMeshObstructed
  ) {
    return {
      state: "blocked",
      message: "建物・3Dデータに隠れています",
    };
  }
  if (occlusion.verificationState === "dem-only") {
    // 建物遮蔽の確認機能は撤去済み（DEM地形のみで判定する）。「確認中」を
    // 名乗る処理はもう存在しないため、地形に遮られていなければ何も表示
    // しない（＝通常通り見えている状態として扱う）。
    return null;
  }
  return null;
}
