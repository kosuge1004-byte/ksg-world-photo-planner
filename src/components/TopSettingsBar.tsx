import { useState } from "react";

import type { CameraSettings } from "../types/camera";
import type { PrecisionSettings, RefractionCorrectionMode } from "../types/precision";
import { REFRACTION_MODE_LABELS } from "../types/precision";
import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN } from "../types/camera";

type Props = {
  settings: CameraSettings;
  onChange: (settings: CameraSettings) => void;
  onOpenSavedPlans: () => void;
  onSaveCurrentPlan: () => void;
  onOpenCalendar: () => void;
  onOpenMoonAgeCalendar: () => void;
  precisionSettings: PrecisionSettings;
  onPrecisionSettingsChange: (settings: PrecisionSettings) => void;
};

export function TopSettingsBar({
  settings,
  onChange,
  onOpenSavedPlans,
  onSaveCurrentPlan,
  onOpenCalendar,
  onOpenMoonAgeCalendar,
  precisionSettings,
  onPrecisionSettingsChange,
}: Props) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [precisionMenuOpen, setPrecisionMenuOpen] = useState(false);
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
          <strong>メニュー</strong>
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
          <button type="button" onClick={() => setPrecisionMenuOpen((current) => !current)} aria-expanded={precisionMenuOpen}>
            <b>精度設定</b><small>地表屈折補正などの計算精度</small>
          </button>
          {precisionMenuOpen && (
            <fieldset className="precision-settings-panel">
              <legend>地表屈折補正</legend>
              {(["auto", "standard", "none"] as RefractionCorrectionMode[]).map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    name="refraction-correction-mode"
                    value={mode}
                    checked={precisionSettings.refractionCorrectionMode === mode}
                    onChange={() => onPrecisionSettingsChange({
                      ...precisionSettings,
                      refractionCorrectionMode: mode,
                    })}
                  />
                  <span>{REFRACTION_MODE_LABELS[mode]}</span>
                  {mode === "auto" && <small>初期値</small>}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}
      <label className="top-setting focal-setting">
        <span>焦点距離</span>
        <span className="top-setting-value">
          <input type="number" min={FOCAL_LENGTH_MIN} max={FOCAL_LENGTH_MAX} value={settings.focalLengthMm} onChange={(event) => setFocal(Number(event.target.value))}/>
          <b>mm</b>
          <i aria-hidden="true">⌕</i>
        </span>
        <small>フルサイズ専用</small>
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
        <button type="button" className="top-preset-button" onClick={onOpenSavedPlans}><b aria-hidden="true">▣</b><span>プリセット</span></button>
        <button type="button" className="top-favorite-button" aria-label="現在の構図を保存" onClick={onSaveCurrentPlan}><b aria-hidden="true">☆</b></button>
      </nav>
    </header>
  );
}
