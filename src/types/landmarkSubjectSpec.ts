/**
 * 登録スポットの「被写体をどこに置くか」の明示仕様（2026-09-29）。
 *
 * すべての登録スポットは次のどれか1つを必ず持つ。型で強制されるため、
 * 新規追加時に書き忘れるとビルドが失敗する。
 *
 * - 地表:   subjectSurface "terrain",   heightMeters 0
 *           （被写体はDEM地表そのもの。標高はGSI 1m/5m/10m DEMから地点ごとに取得する）
 * - 構造物: subjectSurface "structure", heightMeters > 0
 *           （接地面＝登録座標のDEM地表からの頂上までの高さ。単位m）
 * - 構造物（高さ未確認）: heightMeters null, heightStatus "unverified"
 *           既存データの移行用。tests/regression/landmark-subject-spec.test.mjs の
 *           固定リストにある地点だけが許され、リストは減らすことしかできない。
 *
 * 標高（海抜）ではなく「地表からの高さ」で持つ理由: 地表標高は計算時にDEMと
 * JPGEO2024から同じ手順で求めるため、カタログに標高を重複させると、DEM更新や
 * ジオイド版の違いで食い違いが生じる。
 */
export type LandmarkSubjectSpec =
  | { subjectSurface: "terrain"; heightMeters: 0; heightStatus?: never }
  | { subjectSurface: "structure"; heightMeters: number; heightStatus?: never }
  | { subjectSurface: "structure"; heightMeters: null; heightStatus: "unverified" };

/** 構造物の高さとして許す範囲（最小は屋根判定の最小クリアランス、最大は634mを含む）。 */
export const LANDMARK_STRUCTURE_HEIGHT_MIN_METERS = 1.5;
export const LANDMARK_STRUCTURE_HEIGHT_MAX_METERS = 700;

export function landmarkStructureHeightMeters(spec: LandmarkSubjectSpec): number | undefined {
  return spec.subjectSurface === "structure" && typeof spec.heightMeters === "number"
    ? spec.heightMeters
    : undefined;
}
