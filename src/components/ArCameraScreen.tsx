import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { resolveGroundPoint } from "../height/heightResolver";
import type { CalculationMode } from "../types/camera";
import type { CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { AccuracyMode } from "../types/precision";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import {
  computeCameraFovDegrees,
  getAndroidRearCameraInfo,
  matchAndroidCameraFromLabel,
} from "../ar/nativeCameraInfo";
import { startEnvironmentCamera, stopCameraStream } from "../ar/cameraSession";
import { loadArOrientationOffset, saveArOrientationOffset } from "../ar/orientationOffset";
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
  horizontalFovDeg: number;
  verticalFovDeg: number;
  focalLengthMm: number;
  source: "android-camera2";
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
  const [cameraProjection, setCameraProjection] = useState<ArCameraProjection | null>(null);
  // 2026-08-27追記: 方位センサーは磁気干渉等でズレることがあるため、
  // 画面を指でスワイプして、実際のカメラ映像と3D表示を手動で合わせられる
  // ようにする（詳細はsrc/ar/orientationOffset.tsのコメント参照）。
  const [orientationOffset, setOrientationOffset] = useState(() => loadArOrientationOffset());
  const orientationOffsetRef = useRef(orientationOffset);
  orientationOffsetRef.current = orientationOffset;
  const swipeStartRef = useRef<{ x: number; y: number; offset: typeof orientationOffset } | null>(null);
  const handleCalibrationPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipeStartRef.current = { x: event.clientX, y: event.clientY, offset: orientationOffsetRef.current };
  };
  const handleCalibrationPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    if (!start || !cameraProjection) return;
    const stageWidth = event.currentTarget.clientWidth || 1;
    const stageHeight = event.currentTarget.clientHeight || 1;
    // 画面いっぱいのスワイプ（stage幅/高さ分）が、ちょうどカメラの
    // 画角（horizontalFovDeg/verticalFovDeg）分の回転に対応するようにする。
    // これにより、実際にカメラに映っている景色の見た目の動きと、
    // 3D表示の動きが一致し、直感的に合わせられる。
    const dxDegrees = ((event.clientX - start.x) / stageWidth) * cameraProjection.horizontalFovDeg;
    const dyDegrees = ((event.clientY - start.y) / stageHeight) * cameraProjection.verticalFovDeg;
    setOrientationOffset({
      // 画面を右にスワイプ＝景色を右へ動かしたい＝3D表示を左（マイナス）へ
      // ずらす必要があるため符号を反転する。
      headingOffsetDegrees: start.offset.headingOffsetDegrees - dxDegrees,
      // 画面を下にスワイプ＝見上げる角度を下げたい＝pitchを減らす。
      pitchOffsetDegrees: start.offset.pitchOffsetDegrees - dyDegrees,
    });
  };
  const handleCalibrationPointerUp = () => {
    if (!swipeStartRef.current) return;
    swipeStartRef.current = null;
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
      setCameraProjection(null);
      onCameraProjectionChange?.(null);
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
      setCameraProjection(null);
      onCameraProjectionChange?.(null);

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

        const rearCameras = await getAndroidRearCameraInfo();
        if (disposed || generation !== generationRef.current) return;
        const matched = matchAndroidCameraFromLabel(state.label, rearCameras);
        if (!matched) {
          setCameraDetail(
            rearCameras.length > 0
              ? "Camera2情報は取得済みですが、WebView映像のカメラIDを安全に特定できないため画角の自動適用は保留しています。"
              : "この環境では実焦点距離のネイティブ情報を取得できません。カメラ映像はそのまま利用できます。"
          );
          return;
        }

        const fov = computeCameraFovDegrees(matched);
        if (!fov) {
          setCameraDetail("使用中カメラは特定できましたが、画角計算に必要なCamera2情報が不足しています。");
          return;
        }
        const projection: ArCameraProjection = {
          horizontalFovDeg: fov.horizontal,
          verticalFovDeg: fov.vertical,
          focalLengthMm: fov.focalLengthMm,
          source: "android-camera2",
        };
        setCameraProjection(projection);
        onCameraProjectionChange?.(projection);
        setCameraDetail(
          `Camera2同期: ${fov.focalLengthMm.toFixed(2)}mm / 水平FOV ${fov.horizontal.toFixed(1)}° / 垂直FOV ${fov.vertical.toFixed(1)}°`
        );
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
      setCameraProjection(null);
      onCameraProjectionChange?.(null);
    };
  }, [open, onCameraProjectionChange]);

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
        className="ar-camera-stage"
        onPointerDown={handleCalibrationPointerDown}
        onPointerMove={handleCalibrationPointerMove}
        onPointerUp={handleCalibrationPointerUp}
        onPointerCancel={handleCalibrationPointerUp}
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
          location={arLocation}
          orientation={arOrientation}
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
        {(orientationOffset.headingOffsetDegrees !== 0 || orientationOffset.pitchOffsetDegrees !== 0) && (
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
