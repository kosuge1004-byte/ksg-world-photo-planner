import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Viewer } from "cesium";

import {
  applyFreeViewCamera,
  captureFreeViewViewerSnapshot,
  clampFreeViewFocalLengthMm,
  clampFreeViewPitchDegrees,
  FREE_VIEW_MAX_FOCAL_LENGTH_MM,
  FREE_VIEW_MAX_PITCH_DEGREES,
  FREE_VIEW_MIN_FOCAL_LENGTH_MM,
  FREE_VIEW_MIN_PITCH_DEGREES,
  freeViewCameraModel,
  lockFreeViewViewerInputs,
  normalizeFreeViewHeadingDegrees,
  restoreFreeViewViewer,
  type FreeViewPose,
} from "../cesium/freeViewCamera";
import { collectGoogleTilesetsToExclude } from "../cesium/googleTilesetMarker";
import { sceneHasPending3dContent } from "../cesium/interactive3dPerformance";
import {
  freeViewCelestialFrame,
  freeViewDayRange,
  freeViewTrackSampleMinutes,
  freeViewTrackSamples,
  type FreeViewBody,
} from "../freeView/freeViewCelestial";
import { requestTimeZone } from "../network/timeZoneRequest";
import {
  dateFromZonedDateTimeLocal,
  isValidTimeZone,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";
import type { CalculationMode } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { orthometricHeightMeters, withLensCenterHeight } from "../types/points";
import { isAbortError } from "../utils/runtimeErrors";
import { CelestialOverlay } from "./CelestialOverlay";
import { FreeViewGestureLayer } from "./FreeViewGestureLayer";
import { FreeViewSpotSearch } from "./FreeViewSpotSearch";

type Props = {
  /** 通常画面と共有している唯一のCesium Viewer。準備できるまで null。 */
  getViewer: () => Viewer | null;
  viewerReady: boolean;
  /** 共有Viewerのコンテナがこの画面のホストへ移し終わっているか（App.tsxが管理）。 */
  viewerAttached: boolean;
  /** この画面のホスト要素をApp.tsxへ渡す（App.tsxが共有コンテナをここへ移す）。 */
  onHostElement: (element: HTMLDivElement | null) => void;
  /** 開いた時点の通常画面の三脚ピン（コピーして使う。通常画面のピンは動かさない）。 */
  initialObserver: GroundPoint | null;
  initialFocalLengthMm: number;
  initialLensCenterHeightMeters: number;
  initialDateTimeLocal: string;
  initialTimeZone: string;
  calculationMode: CalculationMode;
  searchCenter: { latitude: number; longitude: number } | null;
  /** 精度設定がGoogle 3D（最高精度）か。 */
  googleRequested: boolean;
  cesiumIonConnected: boolean;
  onConnectCesiumIon: () => void;
  mapStatus: string;
  onClose: () => void;
};

const ACTIVE_RENDER_INTERVAL_MS = 1000 / 30;
const IDLE_RENDER_INTERVAL_MS = 250;
const BODY_LABELS: Record<FreeViewBody, string> = { sun: "太陽", moon: "月", milkyWay: "天の川" };

function minutesOfDay(dateTimeLocal: string): number {
  const hour = Number(dateTimeLocal.slice(11, 13));
  const minute = Number(dateTimeLocal.slice(14, 16));
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

function withMinutesOfDay(dateTimeLocal: string, minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
  const mm = String(clamped % 60).padStart(2, "0");
  return `${dateTimeLocal.slice(0, 10)}T${hh}:${mm}`;
}

/**
 * 自由ビューモード（2026-10-09）: 指定した地点に立って360°の景観を見回し、同じ視野に
 * 太陽・月・天の川とその軌跡を重ねる、独立した全画面3D画面。
 *
 * - 被写体ピンは使わない。通常画面の三脚ピン・被写体ピン・設定は読み取るだけで変更しない。
 * - 視線はタッチ操作だけで変える。端末の傾き・向き・GPS・カメラ映像は使わない。
 * - 景観は通常画面と同じCesium Viewer（同じWebGL・同じタイル）をこの画面へ移して表示する。
 *   2つ目のViewerは作らない。閉じる時にカメラ・操作状態・表示を元へ戻す。
 */
export default function FreeViewScreen({
  getViewer,
  viewerReady,
  viewerAttached,
  onHostElement,
  initialObserver,
  initialFocalLengthMm,
  initialLensCenterHeightMeters,
  initialDateTimeLocal,
  initialTimeZone,
  calculationMode,
  searchCenter,
  googleRequested,
  cesiumIonConnected,
  onConnectCesiumIon,
  mapStatus,
  onClose,
}: Props) {
  // この画面だけの状態。通常画面のstateとは別（閉じれば破棄される）。
  const [observer, setObserver] = useState<GroundPoint | null>(initialObserver);
  const [pose, setPose] = useState<FreeViewPose>({ headingDegrees: 0, pitchDegrees: 0 });
  const [focalLengthMm, setFocalLengthMm] = useState(() => clampFreeViewFocalLengthMm(initialFocalLengthMm));
  const [lensCenterHeightMeters, setLensCenterHeightMeters] = useState(initialLensCenterHeightMeters);
  const [dateTimeLocal, setDateTimeLocal] = useState(initialDateTimeLocal);
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const [body, setBody] = useState<FreeViewBody>("sun");
  const [showCelestial, setShowCelestial] = useState(true);
  const [showTracks, setShowTracks] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(initialObserver === null);
  const [aspectRatio, setAspectRatio] = useState(9 / 16);
  const [takenOver, setTakenOver] = useState(false);
  const [sceneLoading, setSceneLoading] = useState(false);
  const [googleActive, setGoogleActive] = useState<boolean | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);

  const stageRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(true);
  const dateTimeLocalRef = useRef(dateTimeLocal);
  dateTimeLocalRef.current = dateTimeLocal;
  const timeZoneRef = useRef(timeZone);
  timeZoneRef.current = timeZone;

  // 画面サイズ（縦横の切替・キーボード表示など）に合わせてアスペクト比を取り直す。
  // 端末の向きセンサーは使わず、表示領域の実寸だけを見る。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = (): void => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (width > 0 && height > 0) setAspectRatio(width / height);
      const viewer = getViewer();
      if (viewer && !viewer.isDestroyed()) {
        viewer.resize();
        dirtyRef.current = true;
      }
    };
    measure();
    const observerInstance = new ResizeObserver(measure);
    observerInstance.observe(stage);
    return () => observerInstance.disconnect();
  }, [getViewer]);

  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // 共有Viewerを一時的に借りる。入る直前の状態を控え、出る時に必ず戻す。
  useEffect(() => {
    if (!viewerReady || !viewerAttached) return;
    const viewer = getViewer();
    if (!viewer || viewer.isDestroyed()) return;

    const snapshot = captureFreeViewViewerSnapshot(viewer);
    lockFreeViewViewerInputs(viewer);
    // 通常画面のピン・線（被写体ピンを含む）は、この画面では表示しない。
    const entitiesWereShown = viewer.entities.show;
    viewer.entities.show = false;
    const dataSourceShown: boolean[] = [];
    for (let index = 0; index < viewer.dataSources.length; index += 1) {
      const dataSource = viewer.dataSources.get(index);
      dataSourceShown.push(dataSource.show);
      dataSource.show = false;
    }
    // Cesiumが自分の時計（現在時刻）で描く太陽・月・星空（天の川の画像を含む）は、
    // この画面で選んだ日時と一致しない。計算した天体と食い違って見えないよう隠す。
    const sceneBodies = [viewer.scene.sun, viewer.scene.moon, viewer.scene.skyBox]
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({ item, shown: item.show }));
    for (const { item } of sceneBodies) item.show = false;
    setGoogleActive(collectGoogleTilesetsToExclude(viewer).length > 0);

    // 描画: 視線・画角を変えた時とタイルの読み込み中だけ30fpsで描き、止まっている間は
    // 0.25秒に1回だけ描く（通常の3D表示と同じ方針。常時高FPSで回さない）。
    let rafId: number | null = null;
    let lastRenderAt = 0;
    let lastLoading: boolean | null = null;
    const renderLoop = (now: number): void => {
      if (viewer.isDestroyed()) return;
      const pending = sceneHasPending3dContent(viewer);
      if (pending !== lastLoading) {
        lastLoading = pending;
        setSceneLoading(pending);
      }
      const active = dirtyRef.current || pending;
      if (now - lastRenderAt >= (active ? ACTIVE_RENDER_INTERVAL_MS : IDLE_RENDER_INTERVAL_MS)) {
        lastRenderAt = now;
        dirtyRef.current = false;
        viewer.scene.requestRender();
        viewer.render();
      }
      rafId = requestAnimationFrame(renderLoop);
    };
    rafId = requestAnimationFrame(() => {
      if (viewer.isDestroyed()) return;
      viewer.resize();
      dirtyRef.current = true;
      rafId = requestAnimationFrame(renderLoop);
    });
    setTakenOver(true);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      setTakenOver(false);
      if (viewer.isDestroyed()) return;
      viewer.entities.show = entitiesWereShown;
      for (const { item, shown } of sceneBodies) item.show = shown;
      for (let index = 0; index < viewer.dataSources.length && index < dataSourceShown.length; index += 1) {
        viewer.dataSources.get(index).show = dataSourceShown[index];
      }
      restoreFreeViewViewer(viewer, snapshot);
      viewer.scene.requestRender();
    };
  }, [getViewer, viewerReady, viewerAttached]);

  // カメラモデル（Cesiumの実カメラと天体の投影が共有する唯一のモデル）。
  const model = useMemo(() => {
    if (!observer) return null;
    try {
      return freeViewCameraModel({
        observer,
        lensCenterHeightMeters,
        headingDegrees: pose.headingDegrees,
        pitchDegrees: pose.pitchDegrees,
        focalLengthMm,
        aspectRatio,
      });
    } catch (error) {
      console.warn("自由ビュー: カメラモデルを作れませんでした", error);
      return null;
    }
  }, [observer, lensCenterHeightMeters, pose, focalLengthMm, aspectRatio]);

  const cameraError = observer && !model ? "視点の高さ・向きの値が不正なため、景観を表示できません。" : null;

  // 実カメラへ反映。位置は常に視点のまま（向き・画角の変更で動かない）。
  useEffect(() => {
    if (!takenOver || !model) return;
    const viewer = getViewer();
    if (!viewer || viewer.isDestroyed()) return;
    applyFreeViewCamera(viewer, model, focalLengthMm, aspectRatio);
    dirtyRef.current = true;
    // 検査用: 反映後の実カメラの値（Cesiumから読み戻した値）を属性に出す。
    // 指定した向き・位置と実カメラが一致しているかを外から確認できる。
    const stage = stageRef.current;
    if (stage) {
      const cartographic = viewer.camera.positionCartographic;
      stage.dataset.cameraHeadingDegrees = (viewer.camera.heading * 180 / Math.PI).toFixed(6);
      stage.dataset.cameraPitchDegrees = (viewer.camera.pitch * 180 / Math.PI).toFixed(6);
      stage.dataset.cameraLatitude = (cartographic.latitude * 180 / Math.PI).toFixed(9);
      stage.dataset.cameraLongitude = (cartographic.longitude * 180 / Math.PI).toFixed(9);
      stage.dataset.cameraEllipsoidalHeight = cartographic.height.toFixed(4);
      const frustum = viewer.camera.frustum as { fov?: number; aspectRatio?: number };
      stage.dataset.cameraFovDegrees = ((frustum.fov ?? Number.NaN) * 180 / Math.PI).toFixed(6);
      stage.dataset.cameraAspectRatio = (frustum.aspectRatio ?? Number.NaN).toFixed(6);
      stage.dataset.modelHorizontalFovDegrees = model.horizontalFovDegrees.toFixed(6);
      stage.dataset.modelVerticalFovDegrees = model.verticalFovDegrees.toFixed(6);
    }
  }, [getViewer, takenOver, model, focalLengthMm, aspectRatio]);

  // 視点のタイムゾーン。端末のタイムゾーンと違う地点でも、実際の時刻（絶対時刻）は変えずに
  // 表示だけをその地点の時刻へ直す。
  useEffect(() => {
    if (!observer) return;
    const controller = new AbortController();
    void requestTimeZone(observer.latitude, observer.longitude, controller.signal)
      .then((resolved) => {
        if (controller.signal.aborted || !resolved || !isValidTimeZone(resolved)) return;
        const previous = timeZoneRef.current;
        if (resolved === previous) return;
        const absolute = dateFromZonedDateTimeLocal(dateTimeLocalRef.current, previous);
        if (!Number.isNaN(absolute.getTime())) {
          setDateTimeLocal(zonedDateTimeLocalFromDate(absolute, resolved));
        }
        setTimeZone(resolved);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) console.warn("自由ビュー: 視点のタイムゾーンを取得できませんでした", error);
      });
    return () => controller.abort();
  }, [observer]);

  const range = useMemo(() => freeViewDayRange(dateTimeLocal, timeZone), [dateTimeLocal, timeZone]);
  const dayStartMs = range?.dayStart.getTime() ?? Number.NaN;
  const dayEndMs = range?.dayEnd.getTime() ?? Number.NaN;
  const lensObserver = useMemo(
    () => {
      if (!observer) return null;
      try {
        return withLensCenterHeight(observer, lensCenterHeightMeters);
      } catch {
        return null;
      }
    },
    [observer, lensCenterHeightMeters]
  );
  const sampleMinutes = model ? freeViewTrackSampleMinutes(model) : 10;

  // 軌跡の天体計算は、視点・日付・天体・刻みが変わった時だけ行う（視線を回しても再計算しない）。
  const trackSamples = useMemo(() => {
    if (!lensObserver || !showTracks || !Number.isFinite(dayStartMs) || !Number.isFinite(dayEndMs)) return [];
    try {
      return freeViewTrackSamples(
        lensObserver,
        calculationMode,
        { date: new Date(dayStartMs), dayStart: new Date(dayStartMs), dayEnd: new Date(dayEndMs) },
        timeZone,
        sampleMinutes,
        body
      );
    } catch (error) {
      console.warn("自由ビュー: 軌跡を計算できませんでした", error);
      return [];
    }
  }, [lensObserver, showTracks, dayStartMs, dayEndMs, calculationMode, timeZone, sampleMinutes, body]);

  const frame = useMemo(() => {
    if (!model || !range) return null;
    try {
      return freeViewCelestialFrame({
        model,
        date: range.date,
        calculationMode,
        body,
        showCelestial,
        showTracks,
        trackSamples,
      });
    } catch (error) {
      console.warn("自由ビュー: 天体を計算できませんでした", error);
      return null;
    }
  }, [model, range, calculationMode, body, showCelestial, showTracks, trackSamples]);

  const selectedPoint = frame?.points.find((point) => point.id === body) ?? null;

  const handleObserverResolved = useCallback((next: GroundPoint): void => {
    setObserver(next);
    setSearchOpen(false);
  }, []);

  const setNow = (): void => {
    setDateTimeLocal(zonedDateTimeLocalFromDate(new Date(), timeZone));
  };

  // 状態の案内。景観が出ていないのに出ているように見せない。
  const notices: Array<{ key: string; text: string; action?: { label: string; run: () => void } }> = [];
  if (!online) {
    notices.push({ key: "offline", text: "オフラインのため、新しい景観データを読み込めません。" });
  }
  if (!viewerReady) {
    notices.push({ key: "loading-viewer", text: mapStatus || "3Dデータを読み込み中…" });
  } else if (googleActive === false) {
    if (!googleRequested) {
      notices.push({
        key: "standard",
        text: "精度設定が「最高精度（Google 3D）」ではないため、Googleの3D景観ではなく標準の3D地形を表示しています。切り替えはメニューの精度設定から行えます。",
      });
    } else if (!cesiumIonConnected) {
      notices.push({
        key: "ion",
        text: "Cesium ionが未接続のため、Googleの3D景観を表示できません（標準の3D地形を表示中）。",
        action: { label: "Cesium ionに接続する", run: onConnectCesiumIon },
      });
    } else {
      notices.push({
        key: "google-unavailable",
        text: "Googleの3D景観を読み込めませんでした（標準の3D地形を表示中）。通信状態、またはCesium ionの利用上限をご確認ください。",
      });
    }
  }
  if (cameraError) notices.push({ key: "camera", text: cameraError });

  return (
    <div className="free-view-screen" role="dialog" aria-modal="true" aria-label="自由ビューモード">
      <header className="free-view-header">
        <button type="button" className="free-view-back" onClick={onClose}>戻る</button>
        <div className="free-view-title">
          <strong>自由ビューモード</strong>
          <span>{observer?.label ?? "立つ場所が未設定"}</span>
        </div>
        <button type="button" className="free-view-search-open" onClick={() => setSearchOpen(true)}>
          スポット検索
        </button>
      </header>

      {notices.length > 0 && (
        <div className="free-view-notices" aria-live="polite">
          {notices.map((notice) => (
            <p key={notice.key}>
              {notice.text}
              {notice.action && (
                <button type="button" onClick={notice.action.run}>{notice.action.label}</button>
              )}
            </p>
          ))}
        </div>
      )}

      <div className="free-view-stage" ref={stageRef}>
        <div className="free-view-host" ref={onHostElement} />
        {observer && frame && (
          <CelestialOverlay
            points={frame.points}
            tracks={frame.tracks}
            milkyWayPath={frame.milkyWayPath}
            visibility={frame.visibility}
            occlusion={frame.occlusion}
            idPrefix="free-view-"
          />
        )}
        <FreeViewGestureLayer
          pose={pose}
          focalLengthMm={focalLengthMm}
          fov={model}
          disabled={!observer || !model}
          onPoseChange={setPose}
          onFocalLengthChange={setFocalLengthMm}
        />
        {observer && (
          <div className="free-view-hud" aria-live="off">
            <span>方位 {pose.headingDegrees.toFixed(1)}°</span>
            <span>仰角 {pose.pitchDegrees >= 0 ? "+" : ""}{pose.pitchDegrees.toFixed(1)}°</span>
            <span>{focalLengthMm < 100 ? focalLengthMm.toFixed(1) : focalLengthMm.toFixed(0)}mm</span>
            <span>{dateTimeLocal.replace("T", " ")}</span>
          </div>
        )}
        {observer && viewerReady && sceneLoading && (
          <div className="free-view-loading">景観を読み込み中…</div>
        )}
        {!observer && !searchOpen && (
          <div className="free-view-empty">
            <p>立つ場所が決まっていません。</p>
            <button type="button" onClick={() => setSearchOpen(true)}>スポット検索で場所を決める</button>
          </div>
        )}
        {searchOpen && (
          <FreeViewSpotSearch
            center={observer
              ? { latitude: observer.latitude, longitude: observer.longitude }
              : searchCenter}
            canClose
            onClose={() => setSearchOpen(false)}
            onObserverResolved={handleObserverResolved}
          />
        )}
      </div>

      <section className={`free-view-controls${panelOpen ? " open" : ""}`}>
        <button
          type="button"
          className="free-view-controls-toggle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((current) => !current)}
        >
          {panelOpen ? "操作パネルを閉じる ▼" : "操作パネルを開く ▲"}
        </button>
        {panelOpen && (
          <div className="free-view-controls-body">
            <div className="free-view-row">
              <div className="free-view-segment" role="group" aria-label="天体">
                {(Object.keys(BODY_LABELS) as FreeViewBody[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={body === id ? "active" : ""}
                    aria-pressed={body === id}
                    onClick={() => setBody(id)}
                  >{BODY_LABELS[id]}</button>
                ))}
              </div>
              <label className="free-view-check">
                <input type="checkbox" checked={showCelestial} onChange={(event) => setShowCelestial(event.target.checked)} />
                天体
              </label>
              <label className="free-view-check">
                <input type="checkbox" checked={showTracks} onChange={(event) => setShowTracks(event.target.checked)} />
                軌跡
              </label>
            </div>

            <div className="free-view-row">
              <input
                type="date"
                aria-label="日付"
                value={dateTimeLocal.slice(0, 10)}
                onChange={(event) => {
                  if (/^\d{4}-\d{2}-\d{2}$/u.test(event.target.value)) {
                    setDateTimeLocal(`${event.target.value}T${dateTimeLocal.slice(11, 16) || "12:00"}`);
                  }
                }}
              />
              <input
                type="time"
                aria-label="時刻"
                value={dateTimeLocal.slice(11, 16)}
                onChange={(event) => {
                  if (/^\d{2}:\d{2}$/u.test(event.target.value)) {
                    setDateTimeLocal(`${dateTimeLocal.slice(0, 10)}T${event.target.value}`);
                  }
                }}
              />
              <button type="button" onClick={setNow}>現在</button>
              <small className="free-view-timezone">{timeZone}</small>
            </div>
            <input
              className="free-view-time-slider"
              type="range"
              min={0}
              max={1439}
              step={1}
              aria-label="時間軸（0:00〜23:59）"
              value={minutesOfDay(dateTimeLocal)}
              onChange={(event) => setDateTimeLocal(withMinutesOfDay(dateTimeLocal, Number(event.target.value)))}
            />

            <div className="free-view-row">
              <label className="free-view-number">
                焦点距離
                <input
                  type="number"
                  inputMode="decimal"
                  min={FREE_VIEW_MIN_FOCAL_LENGTH_MM}
                  max={FREE_VIEW_MAX_FOCAL_LENGTH_MM}
                  step={1}
                  value={Math.round(focalLengthMm * 10) / 10}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value > 0) setFocalLengthMm(clampFreeViewFocalLengthMm(value));
                  }}
                />mm
              </label>
              <input
                className="free-view-focal-slider"
                type="range"
                min={Math.log(FREE_VIEW_MIN_FOCAL_LENGTH_MM)}
                max={Math.log(FREE_VIEW_MAX_FOCAL_LENGTH_MM)}
                step={0.001}
                aria-label="焦点距離（9〜1600mm）"
                value={Math.log(focalLengthMm)}
                onChange={(event) => setFocalLengthMm(clampFreeViewFocalLengthMm(Math.exp(Number(event.target.value))))}
              />
            </div>

            <div className="free-view-row">
              <label className="free-view-number">
                方位
                <input
                  type="number"
                  inputMode="decimal"
                  step={1}
                  value={Math.round(pose.headingDegrees * 10) / 10}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      setPose((current) => ({ ...current, headingDegrees: normalizeFreeViewHeadingDegrees(value) }));
                    }
                  }}
                />°
              </label>
              <label className="free-view-number">
                仰角
                <input
                  type="number"
                  inputMode="decimal"
                  min={FREE_VIEW_MIN_PITCH_DEGREES}
                  max={FREE_VIEW_MAX_PITCH_DEGREES}
                  step={1}
                  value={Math.round(pose.pitchDegrees * 10) / 10}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      setPose((current) => ({ ...current, pitchDegrees: clampFreeViewPitchDegrees(value) }));
                    }
                  }}
                />°
              </label>
              <button type="button" onClick={() => setPose((current) => ({ ...current, headingDegrees: 0 }))}>北へ戻す</button>
              <button type="button" onClick={() => setPose((current) => ({ ...current, pitchDegrees: 0 }))}>水平へ戻す</button>
            </div>

            <div className="free-view-row">
              <label className="free-view-number">
                レンズの高さ
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={500}
                  step={0.1}
                  value={lensCenterHeightMeters}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value >= 0 && value <= 500) setLensCenterHeightMeters(value);
                  }}
                />m
              </label>
              {observer && (
                <small className="free-view-observer-info">
                  地面の標高 {orthometricHeightMeters(observer).toFixed(1)}m
                  {selectedPoint && showCelestial
                    ? `　${BODY_LABELS[body]}: 方位${selectedPoint.azimuthDegrees.toFixed(1)}° 高度${selectedPoint.altitudeDegrees.toFixed(1)}°`
                    : ""}
                </small>
              )}
            </div>
            <small className="free-view-footnote">
              地形・建物で天体が隠れるかどうかは、この画面では判定していません（未判定）。
              景観が地面にめり込んで見える場合は、レンズの高さを上げてください。
            </small>
          </div>
        )}
      </section>
    </div>
  );
}
