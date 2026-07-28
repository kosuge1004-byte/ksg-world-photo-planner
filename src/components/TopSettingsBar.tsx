import {
  useEffect,
  useRef,
  useState,
} from "react";

import type { CameraSettings } from "../types/camera";
import type { PrecisionSettings, RefractionCorrectionMode } from "../types/precision";
import { DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS, DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS, REFRACTION_MODE_LABELS } from "../types/precision";
import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN } from "../types/camera";
import { parseFocalLengthInput } from "../utils/focalLengthInput";

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
  const [focalLengthInput, setFocalLengthInput] = useState(
    String(settings.focalLengthMm)
  );
  const [focalLengthErrorOpen, setFocalLengthErrorOpen] = useState(false);
  const focalLengthInputRef = useRef<HTMLInputElement>(null);
  const focalLengthErrorCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // プレビューのズーム操作など、入力欄以外から変更された焦点距離も同期する。
    if (document.activeElement !== focalLengthInputRef.current) {
      setFocalLengthInput(String(settings.focalLengthMm));
    }
  }, [settings.focalLengthMm]);

  useEffect(() => {
    if (!focalLengthErrorOpen) return;
    focalLengthErrorCloseRef.current?.focus();

    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocalLengthErrorOpen(false);
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [focalLengthErrorOpen]);

  const commitFocalLength = () => {
    const result = parseFocalLengthInput(focalLengthInput);
    if (!result.valid) {
      setFocalLengthErrorOpen(true);
      return;
    }

    setFocalLengthInput(String(result.value));
    onChange({ ...settings, focalLengthMm: result.value });
  };
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
              <legend>精度設定</legend>
              <label>
                <input
                  type="radio"
                  name="accuracy-mode"
                  checked={precisionSettings.accuracyMode === "standard"}
                  onChange={() => onPrecisionSettingsChange({
                    ...precisionSettings,
                    accuracyMode: "standard",
                  })}
                />
                <span>標準</span><small>初期値・従来どおり</small>
              </label>
              <label>
                <input
                  type="radio"
                  name="accuracy-mode"
                  checked={precisionSettings.accuracyMode === "highest"}
                  onChange={() => onPrecisionSettingsChange({
                    ...precisionSettings,
                    accuracyMode: "highest",
                  })}
                />
                <span>最高精度</span>
              </label>
              <small>
                検索速度と検索方法は変えず、「三脚ピンを置く」の後に利用可能な最詳細データで位置を再計算します。
                データにない樹木・工事・仮設物などは保証できません。
              </small>
            </fieldset>
          )}
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
              <div className="precision-number-setting">
                <strong>被写体を遮蔽物として扱わない距離</strong>
                {([
                  ["under100m", "被写体まで100m未満"],
                  ["from100mTo500m", "被写体まで100～500m"],
                  ["from500mTo2km", "被写体まで500m～2km"],
                  ["over2km", "被写体まで2km以上"],
                ] as const).map(([key, label]) => (
                  <label key={key} htmlFor={`subject-obstruction-exclusion-${key}`}>
                    <span>{label}</span>
                    <span>
                      <input
                        id={`subject-obstruction-exclusion-${key}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={500}
                        step={1}
                        value={precisionSettings.subjectObstructionExclusionMeters[key]}
                        onChange={(event) => {
                          const parsed = Number(event.target.value);
                          const next = Number.isFinite(parsed)
                            ? Math.min(500, Math.max(0, parsed))
                            : DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS[key];
                          onPrecisionSettingsChange({
                            ...precisionSettings,
                            subjectObstructionExclusionMeters: {
                              ...precisionSettings.subjectObstructionExclusionMeters,
                              [key]: next,
                            },
                          });
                        }}
                      />
                      <small>m</small>
                    </span>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => onPrecisionSettingsChange({
                    ...precisionSettings,
                    subjectObstructionExclusionMeters: {
                      ...DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS,
                    },
                  })}
                >
                  初期値に戻す
                </button>
                <small>三脚－被写体間の遮蔽物確認で、被写体ピン直前の指定範囲を判定対象から除外します。初期値は3m／10m／20m／50mです。</small>
              </div>
              <div className="precision-number-setting">
                <strong>②建物3D遮蔽の詳細判定</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={precisionSettings.buildingOcclusionDetailSettings.detailedEdgeCheckEnabled}
                    onChange={(event) => onPrecisionSettingsChange({
                      ...precisionSettings,
                      buildingOcclusionDetailSettings: {
                        ...precisionSettings.buildingOcclusionDetailSettings,
                        detailedEdgeCheckEnabled: event.target.checked,
                      },
                    })}
                  />
                  <span>太陽・月の視直径を考慮した縁判定を有効にする</span>
                </label>
                <label htmlFor="building-occlusion-edge-sample-count">
                  <span>縁のサンプル点数</span>
                  <select
                    id="building-occlusion-edge-sample-count"
                    value={precisionSettings.buildingOcclusionDetailSettings.edgeSampleCount}
                    disabled={!precisionSettings.buildingOcclusionDetailSettings.detailedEdgeCheckEnabled}
                    onChange={(event) => onPrecisionSettingsChange({
                      ...precisionSettings,
                      buildingOcclusionDetailSettings: {
                        ...precisionSettings.buildingOcclusionDetailSettings,
                        edgeSampleCount: Number(event.target.value) as 4 | 8 | 12,
                      },
                    })}
                  >
                    <option value={4}>4点</option>
                    <option value={8}>8点（初期値）</option>
                    <option value={12}>12点</option>
                  </select>
                </label>
                <label htmlFor="building-occlusion-threshold-percent">
                  <span>「遮蔽物あり」と判定する遮蔽割合</span>
                  <span>
                    <input
                      id="building-occlusion-threshold-percent"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step={5}
                      disabled={!precisionSettings.buildingOcclusionDetailSettings.detailedEdgeCheckEnabled}
                      value={precisionSettings.buildingOcclusionDetailSettings.obstructedThresholdPercent}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        const next = Number.isFinite(parsed)
                          ? Math.min(100, Math.max(0, parsed))
                          : DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS.obstructedThresholdPercent;
                        onPrecisionSettingsChange({
                          ...precisionSettings,
                          buildingOcclusionDetailSettings: {
                            ...precisionSettings.buildingOcclusionDetailSettings,
                            obstructedThresholdPercent: next,
                          },
                        });
                      }}
                    />
                    <small>%</small>
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => onPrecisionSettingsChange({
                    ...precisionSettings,
                    buildingOcclusionDetailSettings: {
                      ...DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS,
                    },
                  })}
                >
                  初期値に戻す
                </button>
                <small>
                  OFFの場合は従来どおり天体の中心1点だけで建物との遮蔽を判定します。ONにすると太陽・月の円盤の縁も追加でサンプリングし、
                  遮蔽されたサンプルの割合が指定した割合以上のときだけ「遮蔽物あり」と判定します（天の川・北極星は対象外）。
                  サンプル点が増えるほど②の検索時間が長くなります。初期値はOFF／8点／50%です。
                </small>
              </div>
            </fieldset>
          )}
        </div>
      )}
      <label className="top-setting focal-setting">
        <span>焦点距離</span>
        <span className="top-setting-value">
          <input
            ref={focalLengthInputRef}
            type="text"
            inputMode="decimal"
            value={focalLengthInput}
            aria-invalid={focalLengthErrorOpen}
            aria-describedby="focal-length-input-range"
            onChange={(event) => {
              const nextInput = event.target.value;
              setFocalLengthInput(nextInput);
              if (focalLengthErrorOpen) setFocalLengthErrorOpen(false);
              const result = parseFocalLengthInput(nextInput);
              if (result.valid) {
                // 有効範囲に入った時点でプレビューへリアルタイム反映する。
                onChange({ ...settings, focalLengthMm: result.value });
              }
            }}
            onBlur={commitFocalLength}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <b>mm</b>
          <i aria-hidden="true">⌕</i>
        </span>
        <small id="focal-length-input-range">
          {FOCAL_LENGTH_MIN}～{FOCAL_LENGTH_MAX}・フルサイズ
        </small>
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
      {focalLengthErrorOpen && (
        <div
          className="focal-length-validation-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setFocalLengthErrorOpen(false);
            }
          }}
        >
          <section
            className="focal-length-validation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="focal-length-validation-title"
          >
            <strong id="focal-length-validation-title">焦点距離を確認してください</strong>
            <p>
              焦点距離には{FOCAL_LENGTH_MIN}～{FOCAL_LENGTH_MAX}の数字を入力してください。
            </p>
            <button
              ref={focalLengthErrorCloseRef}
              type="button"
              onClick={() => setFocalLengthErrorOpen(false)}
            >
              閉じる
            </button>
          </section>
        </div>
      )}
    </header>
  );
}
