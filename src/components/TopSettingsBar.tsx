import {
  useEffect,
  useRef,
  useState,
} from "react";

import type { CameraSettings } from "../types/camera";
import type { PrecisionSettings, RefractionCorrectionMode } from "../types/precision";
import {
  REFRACTION_MODE_LABELS,
  TRIPOD_SEARCH_MAX_DISTANCE_ABSOLUTE_METERS,
  TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS,
} from "../types/precision";

const REFRACTION_MODE_DESCRIPTIONS: Record<RefractionCorrectionMode, string> = {
  auto: "利用できる天気データで空気による光の曲がりを補正します。地平線付近ほど効果が大きく、取得時は通信と待ち時間が増えます。",
  standard: "一般的な気温・気圧を使って補正します。追加通信なしで安定して計算できます。",
};
import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN } from "../types/camera";
import { parseFocalLengthInput } from "../utils/focalLengthInput";
import { usePwaInstall, clearOfflineTileCache } from "../pwa/install";
import { getRecordedFreezes, clearRecordedFreezes } from "../diagnostics/freezeDetector";

type Props = {
  settings: CameraSettings;
  onChange: (settings: CameraSettings) => void;
  onOpenSavedPlans: () => void;
  onSaveCurrentPlan: () => void;
  onOpenCalendar: () => void;
  onOpenMoonAgeCalendar: () => void;
  onOpenArCamera: () => void;
  onOpenMap3D: () => void;
  mapDisplayMode: "2d" | "3d";
  precisionSettings: PrecisionSettings;
  onPrecisionSettingsChange: (settings: PrecisionSettings) => void;
  cesiumIonConnected: boolean;
  onConnectCesiumIon: () => void;
  onDisconnectCesiumIon: () => void;
};

export function TopSettingsBar({
  settings,
  onChange,
  onOpenSavedPlans,
  onSaveCurrentPlan,
  onOpenCalendar,
  onOpenMoonAgeCalendar,
  onOpenArCamera,
  onOpenMap3D,
  mapDisplayMode,
  precisionSettings,
  onPrecisionSettingsChange,
  cesiumIonConnected,
  onConnectCesiumIon,
  onDisconnectCesiumIon,
}: Props) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!modeMenuOpen) return;
    function handleOutsidePointer(event: PointerEvent) {
      if (!menuContainerRef.current) return;
      if (event.target instanceof Node && menuContainerRef.current.contains(event.target)) return;
      setModeMenuOpen(false);
    }
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [modeMenuOpen]);
  const [precisionMenuOpen, setPrecisionMenuOpen] = useState(false);
  const [threeDSourceMenuOpen, setThreeDSourceMenuOpen] = useState(false);
  const [mapSourcesOpen, setMapSourcesOpen] = useState(false);
  const [tileCacheClearState, setTileCacheClearState] =
    useState<"idle" | "clearing" | "cleared" | "failed">("idle");
  const handleClearOfflineTileCache = async () => {
    setTileCacheClearState("clearing");
    try {
      const cleared = await clearOfflineTileCache();
      setTileCacheClearState(cleared ? "cleared" : "failed");
    } catch {
      setTileCacheClearState("failed");
    }
  };
  const [lightPollutionGuideOpen, setLightPollutionGuideOpen] = useState(false);
  const [freezeDiagnosticsCopyState, setFreezeDiagnosticsCopyState] =
    useState<"idle" | "copied" | "empty" | "failed">("idle");
  const handleCopyFreezeDiagnostics = async () => {
    const freezes = getRecordedFreezes();
    if (freezes.length === 0) {
      setFreezeDiagnosticsCopyState("empty");
      window.setTimeout(() => setFreezeDiagnosticsCopyState("idle"), 3_000);
      return;
    }
    const lines = [
      "[AstroSightフリーズ診断]",
      `記録件数: ${freezes.length}`,
      ...freezes.map((f, i) =>
        `${i + 1}. ${f.detectedAtIso} 固まった長さ: ${(f.gapMs / 1000).toFixed(1)}秒 ` +
        `直前の処理: ${f.operationTagAtFreezeStart ?? "(特定できず)"}`
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setFreezeDiagnosticsCopyState("copied");
    } catch {
      setFreezeDiagnosticsCopyState("failed");
    }
    window.setTimeout(() => setFreezeDiagnosticsCopyState("idle"), 3_000);
  };

  const closeDetailPanels = () => {
    setPrecisionMenuOpen(false);
    setThreeDSourceMenuOpen(false);
    setMapSourcesOpen(false);
    setLightPollutionGuideOpen(false);
  };

  const toggleDetailPanel = (panel: "precision" | "3d" | "light" | "sources") => {
    const next = {
      precision: panel === "precision" ? !precisionMenuOpen : false,
      threeD: panel === "3d" ? !threeDSourceMenuOpen : false,
      light: panel === "light" ? !lightPollutionGuideOpen : false,
      sources: panel === "sources" ? !mapSourcesOpen : false,
    };
    setPrecisionMenuOpen(next.precision);
    setThreeDSourceMenuOpen(next.threeD);
    setLightPollutionGuideOpen(next.light);
    setMapSourcesOpen(next.sources);
  };
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
    <header className="mobile-top-settings" aria-label="撮影設定" ref={menuContainerRef}>
      <button
        type="button"
        className="hamburger-button"
        aria-label="メニュー"
        aria-expanded={modeMenuOpen}
        onClick={() => {
          if (modeMenuOpen) closeDetailPanels();
          setModeMenuOpen((current) => !current);
        }}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {modeMenuOpen && (
        <div
          className={(precisionMenuOpen || threeDSourceMenuOpen || mapSourcesOpen || lightPollutionGuideOpen)
            ? "calculation-mode-menu precision-open"
            : "calculation-mode-menu"}
          role="dialog"
          aria-label="メニュー"
        >
          <div className="menu-dialog-header">
            <strong>メニュー</strong>
            <button type="button" className="menu-close-button" onClick={() => { closeDetailPanels(); setModeMenuOpen(false); }} aria-label="メニューを閉じる">閉じる</button>
          </div>
          <button type="button" onClick={() => toggleDetailPanel("3d")} aria-expanded={threeDSourceMenuOpen}>
            <b>3D表示選択</b><small>無料・有料の3Dデータを切替</small>
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
          <button type="button" onClick={() => {
            setModeMenuOpen(false);
            onOpenArCamera();
          }}>
            <b>ARカメラ</b><small>実景と3D・天体を重ねて確認</small>
          </button>
          <button type="button" onClick={() => {
            setModeMenuOpen(false);
            onOpenMap3D();
          }}>
            <b>地図を{mapDisplayMode === "3d" ? "2D" : "3D"}表示に切替</b>
            <small>{mapDisplayMode === "3d"
              ? "通常の2D地図に戻す"
              : "対話的な3D表示（タップで三脚配置・ダブルタップでズーム）"}</small>
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
          <button type="button" onClick={() => toggleDetailPanel("precision")} aria-expanded={precisionMenuOpen}>
            <b>精度設定</b><small>三脚候補の検算・屈折補正</small>
          </button>
          <button
            type="button"
            onClick={() => toggleDetailPanel("light")}
            aria-expanded={lightPollutionGuideOpen}
          >
            <b>光害マップの見方</b><small>明るさと天の川撮影の目安</small>
          </button>
          {lightPollutionGuideOpen && (
            <section className="light-pollution-guide" aria-label="光害マップの見方">
              <div className="menu-panel-header"><strong>光害マップの見方</strong><button type="button" onClick={() => setLightPollutionGuideOpen(false)}>閉じる</button></div>
              <div className="light-pollution-guide-row">
                <b>暗い地域</b>
                <span>人工の夜間光が少ない</span>
                <small>天の川撮影：撮りやすい</small>
              </div>
              <div className="light-pollution-guide-row">
                <b>中間の明るさ</b>
                <span>周辺の街明かりの影響あり</span>
                <small>天の川撮影：条件次第</small>
              </div>
              <div className="light-pollution-guide-row">
                <b>明るい地域</b>
                <span>人工の夜間光が多い</span>
                <small>天の川撮影：難しい</small>
              </div>
              <p>明るく表示されるほど人工光が強く、暗いほど人工光が少ない地域です。</p>
              <p className="light-pollution-guide-note">このマップはNASA VIIRS Black Marbleの地上夜間光を示すもので、空の明るさ（skyglow）そのものではありません。月、雲、透明度、天の川の高度・方向は含まれないため、撮影可否を断定する表示ではありません。</p>
            </section>
          )}
          <button
            type="button"
            onClick={() => toggleDetailPanel("sources")}
            aria-expanded={mapSourcesOpen}
          >
            <b>地図出典</b><small>使用中の地図・標高データ</small>
          </button>
          {mapSourcesOpen && (
            <section className="map-data-sources" aria-label="地図データ出典元">
              <div className="menu-panel-header"><strong>地図データ出典元</strong><button type="button" onClick={() => setMapSourcesOpen(false)}>閉じる</button></div>
              <dl>
                <div>
                  <dt>2D地図・地点共有</dt>
                  <dd>Google Maps</dd>
                </div>
                <div>
                  <dt>3D地図・建物・地表形状</dt>
                  <dd>{precisionSettings.accuracyMode === "highest" ? "Google Photorealistic 3D Tiles" : "国土地理院地図＋PLATEAU建物"}</dd>
                </div>
                <div>
                  <dt>日本国内の標高・地形</dt>
                  <dd>国土地理院 標高タイル・ジオイド関連データ</dd>
                </div>
                <div>
                  <dt>地名検索・道路等の登録情報</dt>
                  <dd>© OpenStreetMap contributors / Nominatim</dd>
                </div>
                <div>
                  <dt>標高データの補完</dt>
                  <dd>Cesium World Terrain</dd>
                </div>
              </dl>
              <small>表示・検索・計算内容に応じて、上記の一部または複数を使用します。</small>
              <div className="offline-tile-cache">
                <p>
                  標準3D表示（国土地理院地図＋PLATEAU）で読み込んだ地図タイルは、
                  次回同じ場所を表示するときに素早く出せるよう端末に保存されます
                  （地理院タイル・PLATEAUは複製・保存が認められているデータのため）。
                  Google Photorealistic 3D Tilesはこの保存の対象外です（利用規約により
                  キャッシュ・保存が禁止されているため、常にその都度取得します）。
                </p>
                <button type="button" onClick={() => void handleClearOfflineTileCache()} disabled={tileCacheClearState === "clearing"}>
                  {tileCacheClearState === "clearing" ? "削除中…" : "保存した地図タイルを削除"}
                </button>
                {tileCacheClearState === "cleared" && <small role="status">削除しました。</small>}
                {tileCacheClearState === "failed" && <small role="status">削除できませんでした。時間をおいて再試行してください。</small>}
              </div>
              <nav aria-label="出典元の詳細">
                <a href="https://www.google.com/maps" target="_blank" rel="noreferrer">Google Maps</a>
                <a href="https://developers.google.com/maps/documentation/tile/3d-tiles" target="_blank" rel="noreferrer">Google 3D Tiles</a>
                <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院</a>
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
                <a href="https://cesium.com/platform/cesium-ion/content/cesium-world-terrain/" target="_blank" rel="noreferrer">Cesium World Terrain</a>
              </nav>
            </section>
          )}
          {threeDSourceMenuOpen && (
            <fieldset className="precision-settings-panel">
              <legend>3D表示選択</legend>
              <div className="menu-panel-header"><strong>表示データ</strong><button type="button" onClick={() => setThreeDSourceMenuOpen(false)}>閉じる</button></div>
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
                  <span className="precision-choice-title">
                    <b>Google Photorealistic 3D Tiles</b><small>初期値</small>
                  </span>
                  <small>
                    標準3D表示と同じ計算に加え、3Dマップの見た目がGoogle Photorealistic 3D Tilesになります。遮蔽判定・最終確認は標準モードと同じくDEM地形のみで行います（建物3Dは表示専用です）。従量制サービスの利用量が増えます。
                  </small>
                </span>
              </label>
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
                    <b>国土地理院3D表示</b>
                  </span>
                  <small>
                    Google Photorealistic 3D Tilesを使用しません。天体計算、Karney測地線、DEM、ジオイド、気象連動屈折補正など従量制でない計算は変わりません。
                  </small>
                </span>
              </label>
              <div className="cesium-ion-connection-status">
                {cesiumIonConnected ? (
                  <>
                    <small>✓ ご自身のCesium ionアカウントに接続済みです。</small>
                    <button type="button" onClick={onDisconnectCesiumIon}>接続を解除</button>
                  </>
                ) : (
                  <>
                    <small>Google Photorealistic 3D Tilesの利用には、ご自身のCesium ionアカウントの接続が必要です。</small>
                    <button type="button" onClick={onConnectCesiumIon}>Cesium ionアカウントに接続</button>
                  </>
                )}
              </div>
              <div className="freeze-diagnostics-section">
                <small>
                  画面が固まった(フリーズした)場合、その情報がここに記録されます。固まった直後に押してもらえると、原因調査に役立ちます。
                </small>
                <button type="button" onClick={handleCopyFreezeDiagnostics}>
                  {freezeDiagnosticsCopyState === "copied"
                    ? "コピーしました"
                    : freezeDiagnosticsCopyState === "empty"
                      ? "記録されたフリーズはありません"
                      : freezeDiagnosticsCopyState === "failed"
                        ? "コピーできませんでした"
                        : "フリーズ診断情報をコピー"}
                </button>
                <button type="button" onClick={() => { clearRecordedFreezes(); setFreezeDiagnosticsCopyState("idle"); }}>
                  記録をクリア
                </button>
              </div>
              <div className="precision-data-guide">
                <strong>使用する地形・3Dデータ</strong>
                <small>
                  <b>DEM（地形の高さデータ）</b>、ジオイド、気象補正、天体計算はどちらの表示でも共通です。
                </small>
                <small>
                  <b>PLATEAU（建物を含む立体データ、オープンデータ）</b>は三脚・被写体の高さ（屋根への合わせ込み）に使います。遮蔽判定には使いません（DEM地形のみで判定します）。
                </small>
                <small>
                  <b>Google Photorealistic 3D Tiles</b>はGoogleタイルモードの3Dマップの見た目にのみ使います（規約により、高さの判定・遮蔽判定には使用しません）。詳しいデータほど読込時間と通信量が増える場合があります。
                </small>
                <small>
                  樹木、工事、仮設物など、データに収録されていない障害物は確認できません。
                </small>
              </div>
            </fieldset>
          )}
          {precisionMenuOpen && (
            <fieldset className="precision-settings-panel">
              <legend>精度設定</legend>
              <div className="menu-panel-header"><strong>三脚候補・補正</strong><button type="button" onClick={() => setPrecisionMenuOpen(false)}>閉じる</button></div>
              <div className="precision-subsection">
                <strong>三脚候補の初回探索範囲</strong>
                <label className="precision-choice">
                  <input
                    type="range"
                    min={1000}
                    max={TRIPOD_SEARCH_MAX_DISTANCE_ABSOLUTE_METERS}
                    step={1000}
                    value={precisionSettings.tripodSearchMaxDistanceMeters}
                    onChange={(event) => onPrecisionSettingsChange({
                      ...precisionSettings,
                      tripodSearchMaxDistanceMeters: Number(event.target.value),
                    })}
                  />
                  <span className="precision-choice-copy">
                    <span className="precision-choice-title">
                      <b>最大{(precisionSettings.tripodSearchMaxDistanceMeters / 1000).toFixed(0)}km</b>
                      {precisionSettings.tripodSearchMaxDistanceMeters === TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS && <small>初期値</small>}
                    </span>
                    <small>距離ヒントが無い初回探索（新しい被写体・天体）で対象とする最大距離。狭くすると探索が触れる地形タイルの範囲が減り速くなりますが、これより遠い候補は見つかりません。最大{(TRIPOD_SEARCH_MAX_DISTANCE_ABSOLUTE_METERS / 1000).toFixed(0)}kmまで広げられます。</small>
                  </span>
                </label>
              </div>
              <div className="precision-subsection">
                <strong>地形の陰影表現</strong>
                <label className="precision-choice">
                  <input
                    type="checkbox"
                    checked={precisionSettings.terrainShadingEnabled}
                    onChange={(event) => onPrecisionSettingsChange({
                      ...precisionSettings,
                      terrainShadingEnabled: event.target.checked,
                    })}
                  />
                  <span className="precision-choice-copy">
                    <span className="precision-choice-title"><b>地形に陰影を付ける</b>{!precisionSettings.terrainShadingEnabled && <small>初期値OFF</small>}</span>
                    <small>標準3D表示（Googleタイルモードを除く）の地形に、陰影計算用のデータを追加で読み込みます。OFFの方がタイルの転送量が少なく速くなりますが、地形の立体感が少し平坦になります。標高・位置の精度には影響しません。</small>
                  </span>
                </label>
              </div>
              <div className="precision-subsection">
                <strong>三脚候補ダブルチェック</strong>
                <label className="precision-choice">
                  <input
                    type="checkbox"
                    checked={precisionSettings.tripodCandidateDoubleCheckEnabled}
                    onChange={(event) => onPrecisionSettingsChange({
                      ...precisionSettings,
                      tripodCandidateDoubleCheckEnabled: event.target.checked,
                    })}
                  />
                  <span className="precision-choice-copy">
                    <span className="precision-choice-title"><b>旧方式による独立検算</b>{!precisionSettings.tripodCandidateDoubleCheckEnabled && <small>初期値OFF</small>}</span>
                    <small>本計算後に旧来の全距離探索でも確認します。候補点の採否は変更せず、追加計算のため処理時間とDEM通信量が増えます。</small>
                  </span>
                </label>
              </div>
              <div className="precision-subsection">
                <strong>地表屈折補正</strong>
              {(["auto", "standard"] as RefractionCorrectionMode[]).map((mode) => (
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
