import {
  useEffect,
  useRef,
  useState,
} from "react";

import type { CameraSettings } from "../types/camera";
import type { PrecisionSettings, RefractionCorrectionMode } from "../types/precision";
import { DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS, DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS, REFRACTION_MODE_LABELS } from "../types/precision";

const REFRACTION_MODE_DESCRIPTIONS: Record<RefractionCorrectionMode, string> = {
  auto: "利用できる天気データで空気による光の曲がりを補正します。地平線付近ほど効果が大きく、取得時は通信と待ち時間が増えます。",
  standard: "一般的な気温・気圧を使って補正します。追加通信なしで安定して計算できます。",
  none: "空気による光の曲がりを加えず、天文学上の位置を表示します。追加通信はありません。",
};
import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN } from "../types/camera";
import { parseFocalLengthInput } from "../utils/focalLengthInput";
import { usePwaInstall } from "../pwa/install";

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
  const [installHint, setInstallHint] = useState("");
  const focalLengthInputRef = useRef<HTMLInputElement>(null);
  const focalLengthErrorCloseRef = useRef<HTMLButtonElement>(null);
  const pwaInstall = usePwaInstall();

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

  const installWebApp = async () => {
    setInstallHint("");
    const result = await pwaInstall.install();
    if (result === "accepted" || result === "installed") {
      setModeMenuOpen(false);
      return;
    }
    if (result === "dismissed") {
      setInstallHint("インストールはキャンセルされました。もう一度選択できます。");
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setInstallHint(isIos
      ? "Safariの共有ボタンから「ホーム画面に追加」を選択してください。"
      : "Chromeの︙メニューから「アプリをインストール」または「ホーム画面に追加」を選択してください。");
  };

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
        <div
          className={precisionMenuOpen
            ? "calculation-mode-menu precision-open"
            : "calculation-mode-menu"}
          role="dialog"
          aria-label="メニュー"
        >
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
          {pwaInstall.supported && !pwaInstall.installed && (
            <>
              <button
                type="button"
                onClick={() => void installWebApp()}
                disabled={pwaInstall.installing}
              >
                <b>アプリ</b>
                <small>
                  {pwaInstall.installing
                    ? "インストール画面を準備中"
                    : pwaInstall.canInstall
                      ? "この端末にインストール"
                      : "ホーム画面に追加"}
                </small>
              </button>
              {installHint && (
                <small className="pwa-install-hint" role="status">{installHint}</small>
              )}
            </>
          )}
          <button type="button" onClick={() => setPrecisionMenuOpen((current) => !current)} aria-expanded={precisionMenuOpen}>
            <b>精度設定</b><small>精度・速度・通信量を確認</small>
          </button>
          {precisionMenuOpen && (
            <fieldset className="precision-settings-panel">
              <legend>精度設定</legend>
              <label className="precision-choice">
                <input
                  type="radio"
                  name="accuracy-mode"
                  checked={precisionSettings.accuracyMode === "standard"}
                  onChange={() => onPrecisionSettingsChange({
                    ...precisionSettings,
                    accuracyMode: "standard",
                  })}
                />
                <span className="precision-choice-copy">
                  <span className="precision-choice-title">
                    <b>標準</b><small>初期値</small>
                  </span>
                  <small>
                    現在の検索・三脚位置・プレビュー・遮蔽物判定をそのまま使います。処理が速く、通信量も通常どおりです。
                  </small>
                </span>
              </label>
              <label className="precision-choice">
                <input
                  type="radio"
                  name="accuracy-mode"
                  checked={precisionSettings.accuracyMode === "highest"}
                  onChange={() => onPrecisionSettingsChange({
                    ...precisionSettings,
                    accuracyMode: "highest",
                  })}
                />
                <span className="precision-choice-copy">
                  <span className="precision-choice-title"><b>最高精度</b></span>
                  <small>
                    検索結果を選んだ後だけ、地形や建物を詳しく確認して三脚位置を再計算します。検索速度は変わりませんが、確定処理の時間と通信量が増える場合があります。
                  </small>
                </span>
              </label>
              <div className="precision-data-guide">
                <strong>使用する地形・3Dデータ</strong>
                <small>
                  <b>DEM（地形の高さデータ）</b>は地面の起伏を確認します。最高精度では利用可能な最も細かいデータを使います。
                </small>
                <small>
                  <b>Google 3D（建物を含む立体データ）</b>は三脚・被写体の高さと建物の遮蔽確認に使います。詳しいデータほど読込時間と通信量が増える場合があります。
                </small>
                <small>
                  樹木、工事、仮設物など、データに収録されていない障害物は確認できません。
                </small>
              </div>
            </fieldset>
          )}
          {precisionMenuOpen && (
            <fieldset className="precision-settings-panel">
              <legend>地表屈折補正</legend>
              {(["auto", "standard", "none"] as RefractionCorrectionMode[]).map((mode) => (
                <label key={mode} className="precision-choice">
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
                  <span className="precision-choice-copy">
                    <span className="precision-choice-title">
                      <b>{REFRACTION_MODE_LABELS[mode]}</b>
                      {mode === "auto" && <small>初期値</small>}
                    </span>
                    <small>{REFRACTION_MODE_DESCRIPTIONS[mode]}</small>
                  </span>
                </label>
              ))}
              <div className="precision-number-setting">
                <strong>被写体を遮蔽物として扱わない距離</strong>
                <small className="precision-setting-intro">
                  被写体そのものを建物などの遮蔽物と誤判定しないため、ピン直前を確認対象から外す距離です。距離を大きくすると被写体付近の別の障害物を見落とす場合があります。速度と通信量への影響はほぼありません。
                </small>
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
                <small>被写体までの距離帯ごとの初期値は3m／10m／20m／50mです。</small>
              </div>
              <div className="precision-number-setting">
                <strong>建物3D遮蔽の詳細判定</strong>
                <small className="precision-setting-intro">
                  Google 3Dの建物が太陽・月の円盤をどの程度隠すか詳しく確認します。ONにすると判定精度が上がりますが、処理時間と通信量が増える場合があります。
                </small>
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
                <small className="precision-control-help">
                  点数が多いほど円盤の縁を細かく確認できますが、判定に時間がかかります。
                </small>
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
                <small className="precision-control-help">
                  小さい値ほど一部が隠れただけでも遮蔽物ありと判定し、大きい値ほど広く隠れた場合だけ判定します。
                </small>
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
                  OFFの場合は従来どおり天体の中心1点だけを確認します。天の川・北極星は対象外です。初期値はOFF／8点／50%です。
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
