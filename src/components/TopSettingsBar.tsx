import { useState } from "react";

import type { CameraSettings } from "../types/camera";
import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN } from "../types/camera";

type Props = {
  settings: CameraSettings;
  onChange: (settings: CameraSettings) => void;
  onOpenGuidance: () => void;
  onOpenSavedPlans: () => void;
  onSaveCurrentPlan: () => void;
  onOpenCalendar: () => void;
  onOpenMoonAgeCalendar: () => void;
};

export function TopSettingsBar({
  settings,
  onChange,
  onOpenGuidance,
  onOpenSavedPlans,
  onSaveCurrentPlan,
  onOpenCalendar,
  onOpenMoonAgeCalendar,
}: Props) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const setFocal = (value: number) => onChange({ ...settings, focalLengthMm: Math.min(FOCAL_LENGTH_MAX, Math.max(FOCAL_LENGTH_MIN, Math.round(value))) });
  const setHeight = (value: number) => onChange({ ...settings, lensCenterHeightMeters: Math.min(10, Math.max(0.1, value)) });

  return (
    <header className="mobile-top-settings" aria-label="撮影設定">
      <button
        type="button"
        className="hamburger-button"
        aria-label="メニュー"
        aria-expanded={modeMenuOpen}
        onClick={() => setModeMenuOpen((current) => !current)}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {modeMenuOpen && (
        <div className="calculation-mode-menu" role="dialog" aria-label="メニュー">
          <strong>現地誘導</strong>
          <button type="button" onClick={() => {
            setModeMenuOpen(false);
            onOpenGuidance();
          }}>
            <b>誘導</b><small>三脚ポイントへ誘導</small>
          </button>
          <button type="button" onClick={() => {
            setModeMenuOpen(false);
            onOpenGuidance();
          }}>
            <b>AR</b><small>AR誘導（共通画面）</small>
          </button>
          <button type="button" onClick={() => {
            setModeMenuOpen(false);
            onOpenCalendar();
          }}>
            <b>カレンダー</b><small>撮影予定とプロジェクト</small>
          </button>
          <button type="button" onClick={() => {
            setModeMenuOpen(false);
            onOpenMoonAgeCalendar();
          }}>
            <b>月齢</b><small>月の形と月齢をオフライン表示</small>
          </button>
        </div>
      )}
      <label className="top-setting focal-setting">
        <span>焦点距離</span>
        <span className="top-setting-value">
          <input type="number" min={FOCAL_LENGTH_MIN} max={FOCAL_LENGTH_MAX} value={settings.focalLengthMm} onChange={(event) => setFocal(Number(event.target.value))}/>
          <b>mm</b>
          <i aria-hidden="true">⌕</i>
        </span>
        <small>フルサイズ換算</small>
      </label>
      <label className="top-setting height-setting">
        <span>カメラ高</span>
        <span className="top-setting-value">
          <input type="number" min="0.1" max="10" step="0.1" value={settings.lensCenterHeightMeters} onChange={(event) => setHeight(Number(event.target.value))}/>
          <b>m</b>
          <i aria-hidden="true">⌕</i>
        </span>
      </label>
      <nav className="top-quick-actions" aria-label="クイック操作">
        <button type="button"><b aria-hidden="true">⌖</b><span>現在地</span></button>
        <button type="button" className="top-preset-button" onClick={onOpenSavedPlans}><b aria-hidden="true">▣</b><span>プリセット</span></button>
        <button type="button" className="top-favorite-button" aria-label="現在の構図を保存" onClick={onSaveCurrentPlan}><b aria-hidden="true">☆</b></button>
        <button type="button" className="top-more-button" aria-label="その他"><b aria-hidden="true">⋮</b></button>
      </nav>
    </header>
  );
}
