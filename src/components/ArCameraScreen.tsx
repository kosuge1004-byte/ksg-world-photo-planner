import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { resolveGroundPoint } from "../height/heightResolver";
import type { CalculationMode } from "../types/camera";
import type { CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { AccuracyMode } from "../types/precision";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import {
  getAndroidRearCameraInfo,
  matchAndroidCameraFromLabel,
} from "../ar/nativeCameraInfo";
import {
  AR_DEFAULT_FOCAL_LENGTH_MM,
  AR_FOCAL_LENGTH_STEP_MM,
  displayedFieldOfViewDegrees,
  equivalentFocalLengthFromSensor,
  loadArFocalLength,
  roundFocalLengthMm,
  saveArFocalLength,
  type ArFocalLengthSource,
} from "../ar/cameraFocalLength";
import { startEnvironmentCamera, stopCameraStream } from "../ar/cameraSession";
import { loadArOrientationOffset, saveArOrientationOffset } from "../ar/orientationOffset";
import { orientationOffsetFromSwipe } from "../ar/orientationCalibration";
import { createArOrientationSmoother } from "../ar/orientationSmoothing";
import {
  startArLocationTracking,
  startArOrientationTracking,
  type ArDeviceLocation,
  type ArDeviceOrientation,
  type ArTrackingSnapshot,
} from "../ar/deviceTracking";
import { CelestialMenu } from "./CelestialMenu";
import { ArCesiumOverlay } from "./ArCesiumOverlay";
import { TimelinePanel } from "./TimelinePanel";

export type ArCameraProjection = {
  /** 画面に見えている範囲の横・縦の画角（度）。 */
  horizontalFovDeg: number;
  verticalFovDeg: number;
  /** 35mm判換算の焦点距離（対角線基準）。 */
  focalLengthMm: number;
  source: ArFocalLengthSource;
};

const FOCAL_SOURCE_LABELS: Record<ArFocalLengthSource, string> = {
  manual: "補正済み",
  "android-camera2": "端末のレンズ情報から自動計算",
  default: "推定値・未補正",
};

type Props = {
  open: boolean;
  dateTimeLocal: string;
  timeZone: string;
  calculationMode: CalculationMode;
  refractionWeather?: RefractionWeatherContext;
  timelineLocation: GroundPoint | null;
  visibility: CelestialVisibility;
  celestialMenuOpen: boolean;
  lightPollutionEnabled: boolean;
  subjectAvailable: boolean;
  subjectPoint: GroundPoint | null;
  accuracyMode: AccuracyMode;
  cesiumIonToken: string | undefined;
  lensCenterHeightMeters: number;
  onClose: () => void;
  onSaveCurrentPlan: () => void;
  onChangeDateTime: (value: string) => void;
  onInteractionChange: (interacting: boolean) => void;
  onToggleCelestialMenu: () => void;
  onChangeVisibility: (visibility: CelestialVisibility) => void;
  onChangeLightPollution: (enabled: boolean) => void;
  onRequestSearch: () => void;
  onCameraProjectionChange?: (projection: ArCameraProjection | null) => void;
  onTrackingChange?: (snapshot: ArTrackingSnapshot) => void;
};

export function ArCameraScreen({
  open,
  dateTimeLocal,
  timeZone,
  calculationMode,
  refractionWeather,
  timelineLocation,
  visibility,
  celestialMenuOpen,
  lightPollutionEnabled,
  subjectAvailable,
  subjectPoint,
  accuracyMode,
  cesiumIonToken,
  lensCenterHeightMeters,
  onClose,
  onSaveCurrentPlan,
  onChangeDateTime,
  onInteractionChange,
  onToggleCelestialMenu,
  onChangeVisibility,
  onChangeLightPollution,
  onRequestSearch,
  onCameraProjectionChange,
  onTrackingChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  // 2026-08-28追記: 方位・姿勢センサーの生の値には、端末を静止させて
  // いても細かいノイズが乗るため、そのまま3D表示に反映すると画面が
  // 小刻みに振動して見える。センサーの値を受け取るたびに、この
  // インスタンスを通して平滑化する（src/ar/orientationSmoothing.ts参照）。
  const orientationSmootherRef = useRef(createArOrientationSmoother());
  const [cameraStatus, setCameraStatus] = useState("カメラを準備しています…");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraDetail, setCameraDetail] = useState<string | null>(null);
  // 2026-10-15: カメラ焦点距離補正。焦点距離（35mm判換算）と、映像・画面の寸法から
  // 画面に見えている画角を求め、3D表示へ渡す（src/ar/cameraFocalLength.ts）。
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [cameraLabel, setCameraLabel] = useState<string | null>(null);
  const [focal, setFocal] = useState<{ mm: number; source: ArFocalLengthSource } | null>(null);
  // 補正中は、カメラ映像と3D表示を押した瞬間の状態で止める。
  const [focalAdjusting, setFocalAdjusting] = useState(false);
  const [frozenTracking, setFrozenTracking] = useState<{
    location: ArDeviceLocation | null;
    orientation: ArDeviceOrientation | null;
  } | null>(null);
  const cameraProjection = useMemo<ArCameraProjection | null>(() => {
    if (!focal || !stageSize) return null;
    const fov = displayedFieldOfViewDegrees({
      focalLengthMm: focal.mm,
      videoWidth: videoSize?.width ?? null,
      videoHeight: videoSize?.height ?? null,
      viewWidth: stageSize.width,
      viewHeight: stageSize.height,
    });
    return { ...fov, focalLengthMm: focal.mm, source: focal.source };
  }, [focal, stageSize, videoSize]);
  // 2026-08-27追記: 方位センサーは磁気干渉等でズレることがあるため、
  // 画面を指でスワイプして、実際のカメラ映像と3D表示を手動で合わせられる
  // ようにする（詳細はsrc/ar/orientationOffset.tsのコメント参照）。
  const [orientationOffset, setOrientationOffset] = useState(() => loadArOrientationOffset());
  const orientationOffsetRef = useRef(orientationOffset);
  orientationOffsetRef.current = orientationOffset;
  const swipeStartRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    offset: typeof orientationOffset;
  } | null>(null);
  const handleCalibrationPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (focalAdjusting) return;
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, select, label, a")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    swipeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offset: orientationOffsetRef.current,
    };
  };
  const handleCalibrationPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    setOrientationOffset(orientationOffsetFromSwipe({
      startX: start.x,
      startY: start.y,
      currentX: event.clientX,
      currentY: event.clientY,
      stageWidth: event.currentTarget.clientWidth,
      stageHeight: event.currentTarget.clientHeight,
      startOffset: start.offset,
      projection: cameraProjection,
    }));
  };
  const handleCalibrationPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    swipeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    saveArOrientationOffset(orientationOffsetRef.current);
  };
  const handleCalibrationReset = () => {
    swipeStartRef.current = null;
    const reset = { headingOffsetDegrees: 0, pitchOffsetDegrees: 0 };
    setOrientationOffset(reset);
    saveArOrientationOffset(reset);
  };
  const [mapOpacity, setMapOpacity] = useState(0.42);
  const [arMapStatus, setArMapStatus] = useState("AR 3D地図を準備しています…");
  const [arLocation, setArLocation] = useState<ArDeviceLocation | null>(null);
  // GPSが高度を取得できない端末・状況でのフォールバック用DEM標高。
  // arLocationは位置情報の更新のたびに変わるため、更新ごとにDEMへ問い合わせる
  // のは避け、セッション中に一度だけ取得してキャッシュする
  // （同一セッション内で地表の標高が大きく変わることは想定しない）。
  const [demFallbackAltitudeMeters, setDemFallbackAltitudeMeters] = useState<number | null>(null);
  const [arOrientation, setArOrientation] = useState<ArDeviceOrientation | null>(null);
  const [trackingMessage, setTrackingMessage] = useState("現在地・方位を準備しています…");
  const locationRef = useRef<ArDeviceLocation | null>(null);
  const orientationRef = useRef<ArDeviceOrientation | null>(null);

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      setFocal(null);
      setCameraLabel(null);
      setVideoSize(null);
      setFocalAdjusting(false);
      setFrozenTracking(null);
      setCameraReady(false);
      return;
    }

    const generation = ++generationRef.current;
    // cleanup内でref.currentを直接参照すると、実行時点で別のノードに
    // 差し替わっている可能性があるため、effect開始時点の値を変数へ複製する。
    const videoElement = videoRef.current;
    let disposed = false;

    async function start() {
      setCameraReady(false);
      setCameraDetail(null);
      setCameraStatus("背面カメラへの接続を確認しています…");
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      setFocal(null);
      setCameraLabel(null);

      try {
        const state = await startEnvironmentCamera();
        if (disposed || generation !== generationRef.current) {
          stopCameraStream(state.stream);
          return;
        }
        streamRef.current = state.stream;
        const video = videoRef.current;
        if (!video) {
          stopCameraStream(state.stream);
          return;
        }
        video.srcObject = state.stream;
        await video.play();
        if (disposed || generation !== generationRef.current) return;

        setCameraReady(true);
        const sizeText = state.width && state.height ? `${state.width}×${state.height}` : "解像度取得不可";
        setCameraStatus(`カメラ映像 ${sizeText}`);
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          setVideoSize({ width: video.videoWidth, height: video.videoHeight });
        }

        // 焦点距離の優先順位: 利用者が補正して保存した値 → 端末のレンズ情報 → 推定値。
        const label = state.label;
        setCameraLabel(label);
        const saved = loadArFocalLength(label);
        setFocal(saved !== null
          ? { mm: saved, source: "manual" }
          : { mm: AR_DEFAULT_FOCAL_LENGTH_MM, source: "default" });

        const rearCameras = await getAndroidRearCameraInfo();
        if (disposed || generation !== generationRef.current) return;
        const matched = matchAndroidCameraFromLabel(label, rearCameras);
        if (!matched) {
          setCameraDetail(
            rearCameras.length > 0
              ? "端末のレンズ情報は取得済みですが、使用中のカメラを特定できないため推定値を使っています。"
              : "この環境では端末のレンズ情報を取得できないため、推定値を使っています。"
          );
          return;
        }

        const equivalent = equivalentFocalLengthFromSensor({
          focalLengthMm: matched.focalLengthsMm[0],
          sensorWidthMm: matched.sensorWidthMm,
          sensorHeightMm: matched.sensorHeightMm,
        });
        if (equivalent === null) {
          setCameraDetail("使用中のカメラは特定できましたが、画角の計算に必要なレンズ情報が不足しているため推定値を使っています。");
          return;
        }
        setCameraDetail(
          `端末のレンズ情報: 実焦点距離 ${matched.focalLengthsMm[0].toFixed(2)}mm（35mm判換算 ${roundFocalLengthMm(equivalent).toFixed(1)}mm）`
        );
        if (saved === null) {
          setFocal({ mm: roundFocalLengthMm(equivalent), source: "android-camera2" });
        }
      } catch (error) {
        if (disposed || generation !== generationRef.current) return;
        const name = error instanceof DOMException ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setCameraStatus("カメラを使用できません。端末のカメラ権限を許可してください。");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setCameraStatus("利用できる背面カメラが見つかりません。");
        } else {
          setCameraStatus(error instanceof Error ? error.message : "カメラを開始できませんでした");
        }
      }
    }

    void start();
    return () => {
      disposed = true;
      generationRef.current += 1;
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      const video = videoElement;
      if (video) video.srcObject = null;
      setFocal(null);
    };
  }, [open]);

  useEffect(() => {
    onCameraProjectionChange?.(open ? cameraProjection : null);
  }, [open, cameraProjection, onCameraProjectionChange]);

  // 映像の寸法（縦持ち・横持ちで入れ替わる）と、表示枠の寸法を追跡する。
  useEffect(() => {
    if (!open) return;
    const video = videoRef.current;
    const stage = stageRef.current;
    const updateVideo = () => {
      if (video && video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize((current) =>
          current && current.width === video.videoWidth && current.height === video.videoHeight
            ? current
            : { width: video.videoWidth, height: video.videoHeight }
        );
      }
    };
    const updateStage = () => {
      if (!stage) return;
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (width <= 0 || height <= 0) return;
      setStageSize((current) =>
        current && current.width === width && current.height === height ? current : { width, height }
      );
    };
    video?.addEventListener("loadedmetadata", updateVideo);
    video?.addEventListener("resize", updateVideo);
    updateVideo();
    updateStage();
    const observer = typeof ResizeObserver === "function" && stage ? new ResizeObserver(updateStage) : null;
    if (observer && stage) observer.observe(stage);
    return () => {
      video?.removeEventListener("loadedmetadata", updateVideo);
      video?.removeEventListener("resize", updateVideo);
      observer?.disconnect();
    };
  }, [open]);

  const startFocalAdjust = () => {
    if (!focal) return;
    swipeStartRef.current = null;
    setFrozenTracking({ location: arLocation, orientation: arOrientation });
    videoRef.current?.pause();
    setFocalAdjusting(true);
  };
  const stepFocal = (direction: 1 | -1) => {
    setFocal((current) => current
      ? { ...current, mm: roundFocalLengthMm(current.mm + direction * AR_FOCAL_LENGTH_STEP_MM) }
      : current);
  };
  const decideFocal = () => {
    if (focal) {
      saveArFocalLength(focal.mm, cameraLabel ?? "");
      setFocal({ mm: focal.mm, source: "manual" });
    }
    setFocalAdjusting(false);
    setFrozenTracking(null);
    const video = videoRef.current;
    if (video) void video.play().catch(() => undefined);
  };

  useEffect(() => {
    if (!open) {
      locationRef.current = null;
      orientationRef.current = null;
      setArLocation(null);
      setArOrientation(null);
      onTrackingChange?.({ location: null, orientation: null });
      return;
    }

    let disposed = false;
    let stopLocation: () => void = () => undefined;
    setTrackingMessage("現在地・方位を準備しています…");

    const publish = () => {
      if (disposed) return;
      onTrackingChange?.({
        location: locationRef.current,
        orientation: orientationRef.current,
      });
    };

    const stopOrientation = startArOrientationTracking(
      (rawOrientation) => {
        if (disposed) return;
        const orientation = orientationSmootherRef.current.smooth(rawOrientation);
        orientationRef.current = orientation;
        setArOrientation(orientation);
        setTrackingMessage(locationRef.current ? "現在地・方位を追跡中" : "方位を追跡中・現在地を取得しています…");
        publish();
      },
      (message) => {
        if (!disposed) setTrackingMessage(`方位センサー: ${message}`);
      }
    );

    void startArLocationTracking(
      (location) => {
        if (disposed) return;
        locationRef.current = location;
        setArLocation(location);
        setTrackingMessage(orientationRef.current ? "現在地・方位を追跡中" : "現在地を追跡中・方位を取得しています…");
        publish();
      },
      (message) => {
        if (!disposed) setTrackingMessage(`現在地: ${message}`);
      }
    ).then((stop) => {
      if (disposed) stop();
      else stopLocation = stop;
    });

    return () => {
      disposed = true;
      stopOrientation();
      stopLocation();
      locationRef.current = null;
      orientationRef.current = null;
      onTrackingChange?.({ location: null, orientation: null });
    };
  }, [open, onTrackingChange]);

  useEffect(() => {
    setDemFallbackAltitudeMeters(null);
  }, [open]);

  useEffect(() => {
    if (!arLocation || arLocation.altitudeMeters !== null) return;
    if (demFallbackAltitudeMeters !== null) return;
    let cancelled = false;
    void resolveGroundPoint(arLocation.latitude, arLocation.longitude, "AR現在地")
      .then((point) => {
        if (!cancelled) setDemFallbackAltitudeMeters(point.height);
      })
      .catch(() => {
        // 取得できなければ0mのまま（従来どおり）。再試行は次回のGPS更新を待つ。
      });
    return () => {
      cancelled = true;
    };
  }, [arLocation, demFallbackAltitudeMeters]);

  const liveTimelineLocation: GroundPoint | null = arLocation
    ? {
        latitude: arLocation.latitude,
        longitude: arLocation.longitude,
        height: arLocation.altitudeMeters ?? demFallbackAltitudeMeters ?? 0,
        label: "AR現在地",
      }
    : timelineLocation;

  if (!open) return null;

  return (
    <section className="ar-camera-screen" aria-label="ARカメラ">
      <div
        ref={stageRef}
        className="ar-camera-stage"
        onPointerDown={handleCalibrationPointerDown}
        onPointerMove={handleCalibrationPointerMove}
        onPointerUp={handleCalibrationPointerUp}
        onPointerCancel={handleCalibrationPointerUp}
        onLostPointerCapture={handleCalibrationPointerUp}
      >
        <video
          ref={videoRef}
          className={`ar-camera-video${cameraReady ? " ready" : ""}`}
          playsInline
          muted
          autoPlay
          aria-label="ARカメラ実写映像"
        />
        <ArCesiumOverlay
          active={open}
          location={focalAdjusting && frozenTracking ? frozenTracking.location : arLocation}
          orientation={focalAdjusting && frozenTracking ? frozenTracking.orientation : arOrientation}
          projection={cameraProjection}
          subjectPoint={subjectPoint}
          accuracyMode={accuracyMode}
          cesiumIonToken={cesiumIonToken}
          lensCenterHeightMeters={lensCenterHeightMeters}
          dateTimeLocal={dateTimeLocal}
          timeZone={timeZone}
          calculationMode={calculationMode}
          refractionWeather={refractionWeather}
          visibility={visibility}
          opacity={mapOpacity}
          headingOffsetDegrees={orientationOffset.headingOffsetDegrees}
          pitchOffsetDegrees={orientationOffset.pitchOffsetDegrees}
          onStatusChange={setArMapStatus}
        />
        {cameraReady && focal && !focalAdjusting && (
          <button
            type="button"
            className="ar-focal-correction-button"
            onClick={startFocalAdjust}
          >
            カメラ焦点距離補正
          </button>
        )}
        {focalAdjusting && focal && (
          <div className="ar-focal-correction-panel" role="group" aria-label="カメラ焦点距離補正">
            <span>停止中：3Dの大きさを景色に合わせてください（35mm判換算）</span>
            <div className="ar-focal-correction-row">
              <button type="button" aria-label="焦点距離を0.1mm短くする" onClick={() => stepFocal(-1)}>−</button>
              <strong aria-live="polite">{focal.mm.toFixed(1)}mm</strong>
              <button type="button" aria-label="焦点距離を0.1mm長くする" onClick={() => stepFocal(1)}>＋</button>
              <button type="button" className="ar-focal-correction-decide" onClick={decideFocal}>決定</button>
            </div>
          </div>
        )}
        {!focalAdjusting && (orientationOffset.headingOffsetDegrees !== 0 || orientationOffset.pitchOffsetDegrees !== 0) && (
          <button
            type="button"
            className="ar-calibration-reset"
            onClick={handleCalibrationReset}
            title="画面をスワイプして実際の景色と3D表示を合わせた補正を、元に戻します"
          >
            方角補正をリセット
          </button>
        )}
        {!cameraReady && (
          <div className="ar-camera-foundation" aria-hidden="true">
            <span>AR</span>
          </div>
        )}
        <div className="ar-camera-top-controls">
          <button type="button" className="ar-camera-back-button" onClick={onClose}>
            戻る
          </button>
          <button
            type="button"
            className="ar-camera-favorite-button"
            aria-label="現在の構図を保存"
            onClick={onSaveCurrentPlan}
          >
            ☆
          </button>
        </div>

        <CelestialMenu
          open={celestialMenuOpen}
          visibility={visibility}
          onToggleOpen={onToggleCelestialMenu}
          onChangeVisibility={onChangeVisibility}
          lightPollutionEnabled={lightPollutionEnabled}
          onChangeLightPollution={onChangeLightPollution}
        />

        <label className="ar-camera-map-opacity-control">
          <span>3D透明度</span>
          <input
            type="range"
            min="0"
            max="0.85"
            step="0.05"
            value={mapOpacity}
            onChange={(event) => setMapOpacity(Number(event.target.value))}
          />
          <strong>{Math.round(mapOpacity * 100)}%</strong>
        </label>

        <div className="ar-camera-camera-status" role="status" aria-live="polite">
          <strong>{cameraStatus}</strong>
          {cameraProjection && (
            <span>
              焦点距離 {cameraProjection.focalLengthMm.toFixed(1)}mm（35mm判換算・{FOCAL_SOURCE_LABELS[cameraProjection.source]}）／表示画角 横{cameraProjection.horizontalFovDeg.toFixed(1)}° 縦{cameraProjection.verticalFovDeg.toFixed(1)}°
            </span>
          )}
          {cameraDetail && <span>{cameraDetail}</span>}
          <span>{trackingMessage}</span>
          <span>{arMapStatus}</span>
          {arLocation && (
            <small>
              現在地 {arLocation.latitude.toFixed(6)}, {arLocation.longitude.toFixed(6)} / 精度 ±{Math.round(arLocation.accuracyMeters)}m
            </small>
          )}
          {arOrientation?.headingDegrees !== null && arOrientation?.headingDegrees !== undefined && (
            <small>
              方位 {arOrientation.headingDegrees.toFixed(1)}° / 姿勢 β {arOrientation.betaDegrees?.toFixed(1) ?? "—"}° γ {arOrientation.gammaDegrees?.toFixed(1) ?? "—"}°
            </small>
          )}
          {!subjectAvailable && <small>被写体未設定でもAR表示は利用できます。検索時のみ被写体が必要です。</small>}
        </div>
      </div>

      <div className="ar-camera-timeline">
        <TimelinePanel
          dateTimeLocal={dateTimeLocal}
          location={liveTimelineLocation}
          timeZone={timeZone}
          calculationMode={calculationMode}
          refractionWeather={refractionWeather}
          onChangeDateTime={onChangeDateTime}
          onOpenTransitSearch={onRequestSearch}
          onInteractionChange={onInteractionChange}
        />
      </div>
    </section>
  );
}
