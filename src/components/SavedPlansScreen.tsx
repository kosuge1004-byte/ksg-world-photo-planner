import { useEffect, useState } from "react";

import "./SavedPlansScreen.css";

import type { GuidancePlan } from "../types/guidance";
import { zonedDateTimeLocalFromDate } from "../time/zonedTime";

type Props = {
  open: boolean;
  plans: GuidancePlan[];
  onBack: () => void;
  onApply: (plan: GuidancePlan) => void;
  onGuide: (plan: GuidancePlan) => void;
};

function dateText(plan: GuidancePlan): string {
  return zonedDateTimeLocalFromDate(
    new Date(plan.dateTimeIso),
    plan.timeZone
  ).replace("T", " ");
}

export function SavedPlansScreen({
  open,
  plans,
  onBack,
  onApply,
  onGuide,
}: Props) {
  const [selected, setSelected] = useState<GuidancePlan | null>(null);

  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  if (!open) return null;

  return (
    <section className="saved-plans-screen" aria-label="保存済みプリセット">
      <header>
        <button type="button" onClick={() => selected ? setSelected(null) : onBack()}>
          ‹ 戻る
        </button>
        <h1>{selected ? "プリセット詳細" : "プリセット"}</h1>
        <span aria-hidden="true" />
      </header>

      {selected ? (
        <div className="saved-plan-detail">
          <div className="saved-plan-detail-card">
            <small>{selected.source === "search" ? "検索結果" : "保存構図"}</small>
            <h2>{selected.title}</h2>
            <dl>
              <div><dt>撮影日時</dt><dd>{dateText(selected)}</dd></div>
              <div><dt>天体</dt><dd>{selected.celestialLabel}</dd></div>
              <div><dt>焦点距離</dt><dd>{selected.focalLengthMm}mm</dd></div>
              <div><dt>レンズ中心高</dt><dd>{selected.lensCenterHeightMeters.toFixed(2)}m</dd></div>
              <div><dt>カメラ方位</dt><dd>{selected.cameraAzimuthDegrees.toFixed(2)}°</dd></div>
              <div><dt>カメラ仰角</dt><dd>{selected.cameraAltitudeDegrees.toFixed(2)}°</dd></div>
              <div><dt>三脚位置</dt><dd>{selected.tripod.latitude.toFixed(6)}, {selected.tripod.longitude.toFixed(6)}</dd></div>
              <div><dt>被写体位置</dt><dd>{selected.subject.latitude.toFixed(6)}, {selected.subject.longitude.toFixed(6)}</dd></div>
            </dl>
          </div>
          <button type="button" className="saved-plan-apply" onClick={() => onApply(selected)}>
            構図をメイン画面へ適用
          </button>
          <button type="button" className="saved-plan-guide" onClick={() => onGuide(selected)}>
            三脚ポイントへ誘導
          </button>
        </div>
      ) : (
        <div className="saved-plan-list">
          {plans.length === 0 && (
            <p>保存済み構図はありません。メイン画面上部の星ボタンで現在の構図を保存できます。</p>
          )}
          {plans.map((plan) => (
            <button type="button" key={plan.id} onClick={() => setSelected(plan)}>
              <strong>{plan.title}</strong>
              <span>{dateText(plan)}　{plan.celestialLabel}</span>
              <small>{plan.focalLengthMm}mm　{plan.subject.label}</small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
