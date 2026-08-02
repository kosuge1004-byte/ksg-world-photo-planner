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
    return occlusion.failureMessage
      ? {
          state: "unavailable",
          message: "建物の遮蔽を確認できません",
        }
      : {
          state: "checking",
          message: "建物の遮蔽を確認中です",
        };
  }
  return null;
}
