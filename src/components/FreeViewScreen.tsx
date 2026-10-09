import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Viewer } from "cesium";

import {
  applyFreeViewCamera,
  captureFreeViewViewerSnapshot,
  clampFreeViewFocalLengthMm,
  freeViewCameraModel,
  lockFreeViewViewerInputs,
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
import { withLensCenterHeight } from "../types/points";
import { isAbortError } from "../utils/runtimeErrors";
import { CelestialOverlay } from "./CelestialOverlay";
import { FreeViewGestureLayer } from "./FreeViewGestureLayer";
import { FreeViewSpotSearch } from "./FreeViewSpotSearch";
import { TimelinePanel } from "./TimelinePanel";

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
  const lensCenterHeightMeters = initialLensCenterHeightMeters;
  const [dateTimeLocal, setDateTimeLocal] = useState(initialDateTimeLocal);
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const [body, setBody] = useState<FreeViewBody>("sun");
  // 天体の本体と軌跡は常に表示する（選ぶのは天体の種類だけ）。
  const showCelestial = true;
  const showTracks = true;
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

  const handleObserverResolved = useCallback((next: GroundPoint): void => {
    setObserver(next);
    setSearchOpen(false);
  }, []);

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

        {/* 景観の上に重ねるのは、戻る・天体選択・スポット検索の3つだけ。 */}
        <div className="free-view-top">
          <button type="button" className="free-view-back" onClick={onClose}>戻る</button>
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
          <button type="button" className="free-view-search-open" onClick={() => setSearchOpen(true)}>
            スポット検索
          </button>
        </div>

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
        {observer && viewerReady && sceneLoading && (
          <div className="free-view-loading">景観を読み込み中…</div>
        )}
        {!observer && !searchOpen && (
          <div className="free-view-empty">
            <p>立つ場所が決まっていません。</p>
            <button type="button" onClick={() => setSearchOpen(true)}>スポット検索で場所を決める</button>
          </div>
        )}
      </div>

      {/* メイン画面と同じ時間軸。景観の外（下）に置くので、ロゴ・提供元の表示を覆わない。 */}
      <div className="free-view-timeline">
        <TimelinePanel
          dateTimeLocal={dateTimeLocal}
          location={observer}
          timeZone={timeZone}
          calculationMode={calculationMode}
          onChangeDateTime={setDateTimeLocal}
        />
      </div>

      {/* 検索は画面全体に重ねる（景観の大きさや重なり順に左右されない）。 */}
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
  );
}
