import type { GroundPoint } from "../types/points";
import {
  ellipsoidalHeightMeters,
  withVerticalOffset,
} from "../types/points";

// 数十cm程度のDEM/3Dタイル差を屋根と誤認しない。一般的な建物の屋根は
// この値を十分に上回り、建物でない地点の挙動には影響しない。
export const MIN_STRUCTURE_CLEARANCE_METERS = 1.5;

export type SubjectSurfaceSelectionInput = {
  groundPoint: GroundPoint;
  roofPoint: GroundPoint | null;
  osmPoint: GroundPoint | null;
  requireStructureRoof: boolean;
  knownStructureHeightMeters?: number;
  label: string;
};

export class SubjectRoofResolutionError extends Error {
  readonly code = "SUBJECT_ROOF_UNRESOLVED";

  constructor(label: string) {
    super(
      `${label || "建物"}の頂上高度を確認できなかったため、地上には被写体ピンを配置しませんでした。通信状態を確認して再検索してください。`
    );
    this.name = "SubjectRoofResolutionError";
  }
}

function elevatedAboveGround(point: GroundPoint, groundPoint: GroundPoint): boolean {
  const clearance = ellipsoidalHeightMeters(point) - ellipsoidalHeightMeters(groundPoint);
  return Number.isFinite(clearance) && clearance >= MIN_STRUCTURE_CLEARANCE_METERS;
}

function cataloguedStructurePoint(
  groundPoint: GroundPoint,
  heightMeters: number | undefined,
  label: string
): GroundPoint | null {
  if (!Number.isFinite(heightMeters) || (heightMeters as number) < MIN_STRUCTURE_CLEARANCE_METERS) {
    return null;
  }
  return {
    ...withVerticalOffset(groundPoint, heightMeters as number, label),
    heightSource: "catalogued-structure-height",
    subjectSurfaceTarget: "structure-roof",
    structureHeightMeters: heightMeters,
  };
}

/**
 * 屋上候補を一箇所で確定する。建物・塔であることが判明している場合、
 * PLATEAU/OSM/既知高さのどれも屋上を示せなければDEM地面を返さず失敗する。
 * これにより、非同期の屋根探索失敗が「正常な地上ピン」として保存される
 * 経路を構造的に閉じる。
 */
export function selectSubjectSurfacePoint(input: SubjectSurfaceSelectionInput): GroundPoint {
  const knownPoint = cataloguedStructurePoint(
    input.groundPoint,
    input.knownStructureHeightMeters,
    input.label
  );
  const candidates = [input.roofPoint, input.osmPoint, knownPoint]
    .filter((point): point is GroundPoint => point !== null)
    .filter((point) => elevatedAboveGround(point, input.groundPoint));

  if (candidates.length === 0) {
    if (input.requireStructureRoof) throw new SubjectRoofResolutionError(input.label);
    return {
      ...input.groundPoint,
      subjectSurfaceTarget: input.groundPoint.subjectSurfaceTarget ?? "terrain",
    };
  }

  const tallest = candidates.reduce((current, next) =>
    ellipsoidalHeightMeters(next) > ellipsoidalHeightMeters(current) ? next : current
  );
  return {
    ...tallest,
    subjectSurfaceTarget: "structure-roof",
    structureHeightMeters: Number.isFinite(input.knownStructureHeightMeters)
      ? input.knownStructureHeightMeters
      : tallest.structureHeightMeters,
  };
}
