export const SPOT_SEARCH_PHASE_COUNT = 12 as const;

export type SpotSearchPhaseId =
  | 1 | 2 | 3 | 4 | 5 | 6
  | 7 | 8 | 9 | 10 | 11 | 12;

export type SpotSearchPhase = {
  id: SpotSearchPhaseId;
  label: string;
  startPercent: number;
  endPercent: number;
};

/**
 * スポット検索の責務境界。
 * 第1段階では既存の精密計算ロジックを変更せず、進捗・計測・後続最適化の
 * 安定した接続点として12工程を定義する。
 */
export const SPOT_SEARCH_PHASES: readonly SpotSearchPhase[] = [
  { id: 1, label: "入力値を確認しています", startPercent: 0, endPercent: 2 },
  { id: 2, label: "検索条件を整理しています", startPercent: 2, endPercent: 5 },
  { id: 3, label: "日時候補を生成しています", startPercent: 5, endPercent: 10 },
  { id: 4, label: "共通天文値を計算しています", startPercent: 10, endPercent: 18 },
  { id: 5, label: "天体位置を精密計算しています", startPercent: 18, endPercent: 34 },
  { id: 6, label: "構図成立条件を確認しています", startPercent: 34, endPercent: 45 },
  { id: 7, label: "必要な方位帯と地形範囲を整理しています", startPercent: 45, endPercent: 50 },
  { id: 8, label: "地形データとキャッシュを準備しています", startPercent: 50, endPercent: 65 },
  { id: 9, label: "地形断面を生成しています", startPercent: 65, endPercent: 72 },
  { id: 10, label: "三脚位置を探索しています", startPercent: 72, endPercent: 86 },
  { id: 11, label: "見通しと周辺情報を確認しています", startPercent: 86, endPercent: 97 },
  { id: 12, label: "結果を精密確認して整理しています", startPercent: 97, endPercent: 100 },
] as const;

export function phaseById(id: SpotSearchPhaseId): SpotSearchPhase {
  return SPOT_SEARCH_PHASES[id - 1];
}

export function phaseProgress(
  id: SpotSearchPhaseId,
  fraction = 0,
): number {
  const phase = phaseById(id);
  const normalized = Math.max(0, Math.min(1, fraction));
  return Math.round(
    phase.startPercent + (phase.endPercent - phase.startPercent) * normalized,
  );
}

export function phaseMessage(
  id: SpotSearchPhaseId,
  detail?: string,
): string {
  const phase = phaseById(id);
  return [
    `第${phase.id}/${SPOT_SEARCH_PHASE_COUNT}工程：${phase.label}`,
    detail,
  ].filter(Boolean).join("\n");
}
