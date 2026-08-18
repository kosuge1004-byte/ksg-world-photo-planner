import { useEffect, useRef, useState } from "react";
import type { CalculationMode } from "../types/camera";
import type { CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import {
  computeCameraFovDegrees,
  getAndroidRearCameraInfo,
  matchAndroidCameraFromLabel,
} from "../ar/nativeCameraInfo";
import { startEnvironmentCamera, stopCameraStream } from "../ar/cameraSession";
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
  const [cameraStatus, setCameraStatus] = useState("カメラを準備しています…");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraDetail, setCameraDetail] = useState<string | null>(null);
  const [cameraProjection, setCameraProjection] = useState<ArCameraProjection | null>(null);
  const [mapOpacity, setMapOpacity] = useState(0.42);
  const [arMapStatus, setArMapStatus] = useState("AR 3D地図を準備しています…");
  const [arLocation, setArLocation] = useState<ArDeviceLocation | null>(null);
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
      const video = videoRef.current;
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
      (orientation) => {
        if (disposed) return;
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

  const liveTimelineLocation: GroundPoint | null = arLocation
    ? { latitude: arLocation.latitude, longitude: arLocation.longitude, height: arLocation.altitudeMeters ?? 0, label: "AR現在地" }
    : timelineLocation;

  if (!open) return null;

  return (
    <section className="ar-camera-screen" aria-label="ARカメラ">
      <div className="ar-camera-stage">
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
          dateTimeLocal={dateTimeLocal}
          timeZone={timeZone}
          calculationMode={calculationMode}
          refractionWeather={refractionWeather}
          visibility={visibility}
          opacity={mapOpacity}
          onStatusChange={setArMapStatus}
        />
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
