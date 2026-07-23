import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import "./TripodGuidanceScreen.css";

import {
  cameraAltitudeToSubjectDegrees,
  guidanceBearingDegrees,
  guidanceDistanceMeters,
  localOffsetsMeters,
  movementComponentsMeters,
  normalizeDegrees,
  signedAngleDegrees,
} from "../guidance/geometry";
import { planSpotKey, saveFieldCorrection } from "../guidance/storage";
import { projectCoordinatesToMapPixel } from "../map/webMercator";
import type {
  DeviceAttitude,
  FieldCorrection,
  GuidancePhase,
  GuidancePlan,
  LivePosition,
} from "../types/guidance";
import { groundPointFromCoordinates } from "../cesium/worldTerrain";

type Props = {
  open: boolean;
  plan: GuidancePlan | null;
  onClose: () => void;
  onCorrectionSaved: (correction: FieldCorrection, plan: GuidancePlan) => void;
};

type OrientationPermissionConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type WebKitOrientationEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};

const EMPTY_ATTITUDE: DeviceAttitude = {
  headingDegrees: null,
  cameraAltitudeDegrees: null,
  rollDegrees: null,
  absolute: false,
};

const AR_HORIZONTAL_FOV_DEGREES = 65;
const AR_VERTICAL_FOV_DEGREES = 45;

function guidanceMapZoom(distanceMeters: number): number {
  if (distanceMeters > 5_000) return 12;
  if (distanceMeters > 2_000) return 13;
  if (distanceMeters > 1_000) return 14;
  if (distanceMeters > 400) return 15;
  if (distanceMeters > 150) return 16;
  if (distanceMeters > 60) return 17;
  if (distanceMeters > 20) return 18;
  return 19;
}

function mapCenter(
  current: LivePosition | null,
  plan: GuidancePlan
): { latitude: number; longitude: number } {
  if (!current) return plan.tripod;
  return {
    latitude: (current.latitude + plan.tripod.latitude) / 2,
    longitude: (current.longitude + plan.tripod.longitude) / 2,
  };
}

function formatDistance(value: number | null): string {
  if (value === null) return "測位待ち";
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} km`;
  return `${value < 20 ? value.toFixed(1) : Math.round(value)} m`;
}

function headingText(value: number | null): string {
  return value === null ? "測位待ち" : `${value.toFixed(1)}°`;
}

function overlayPosition(
  azimuthDegrees: number,
  altitudeDegrees: number,
  attitude: DeviceAttitude
): CSSProperties {
  if (
    attitude.headingDegrees === null ||
    attitude.cameraAltitudeDegrees === null
  ) {
    return { left: "-100px", top: "-100px" };
  }
  const horizontalDelta = signedAngleDegrees(
    azimuthDegrees - attitude.headingDegrees
  );
  const verticalDelta = altitudeDegrees - attitude.cameraAltitudeDegrees;
  return {
    left: `${50 + horizontalDelta / AR_HORIZONTAL_FOV_DEGREES * 100}%`,
    top: `${50 - verticalDelta / AR_VERTICAL_FOV_DEGREES * 100}%`,
  };
}

function cameraAltitudeFromOrientation(event: DeviceOrientationEvent): number | null {
  if (event.beta === null) return null;
  const orientationAngle = screen.orientation?.angle ?? 0;
  if (Math.abs(orientationAngle) === 90 && event.gamma !== null) {
    return Math.max(-90, Math.min(90, 90 - Math.abs(event.gamma)));
  }
  return Math.max(-90, Math.min(90, 90 - Math.abs(event.beta)));
}

async function requestOrientationPermission(): Promise<boolean> {
  const constructor = DeviceOrientationEvent as OrientationPermissionConstructor;
  if (typeof constructor.requestPermission !== "function") return true;
  return (await constructor.requestPermission()) === "granted";
}

export function TripodGuidanceScreen({
  open,
  plan,
  onClose,
  onCorrectionSaved,
}: Props) {
  const [stage, setStage] = useState<"gps" | "ar">("gps");
  const [position, setPosition] = useState<LivePosition | null>(null);
  const [attitude, setAttitude] = useState<DeviceAttitude>(EMPTY_ATTITUDE);
  const [locationError, setLocationError] = useState("");
  const [sensorError, setSensorError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [correctionSaved, setCorrectionSaved] = useState(false);
  const [mapSize, setMapSize] = useState({ width: 1, height: 1 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const orientationHandlerRef = useRef<
    ((event: DeviceOrientationEvent) => void) | null
  >(null);
  const elevationRequestRef = useRef(0);
  const groundHeightRef = useRef<{
    latitude: number;
    longitude: number;
    height: number;
  } | null>(null);

  function stopGuidanceSensors(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const handler = orientationHandlerRef.current;
    if (handler) {
      window.removeEventListener("deviceorientationabsolute", handler);
      window.removeEventListener("deviceorientation", handler);
      orientationHandlerRef.current = null;
    }
  }

  useEffect(() => {
    if (!open) {
      stopGuidanceSensors();
      return;
    }
    setStage("gps");
    setAttitude(EMPTY_ATTITUDE);
    setSensorError("");
    setCorrectionSaved(false);
  }, [open, plan?.id]);

  useEffect(() => () => stopGuidanceSensors(), []);

  useEffect(() => {
    if (!open || !plan || !navigator.geolocation) {
      if (open && !navigator.geolocation) {
        setLocationError("この端末は位置情報に対応していません");
      }
      return;
    }
    let active = true;
    const watchId = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        if (!active) return;
        const previous = groundHeightRef.current;
        const shouldRefresh = !previous || guidanceDistanceMeters(
          previous,
          { latitude: coords.latitude, longitude: coords.longitude }
        ) > 8;
        const fallbackHeight = typeof coords.altitude === "number"
          ? coords.altitude
          : previous?.height ?? plan.tripod.height;
        setPosition({
          latitude: coords.latitude,
          longitude: coords.longitude,
          height: fallbackHeight,
          label: "現在地",
          accuracyMeters: coords.accuracy,
          altitudeAccuracyMeters: coords.altitudeAccuracy,
          source: "gps",
          timestampMilliseconds: timestamp,
        });
        setLocationError("");
        if (shouldRefresh) {
          const requestId = ++elevationRequestRef.current;
          void groundPointFromCoordinates(
            coords.latitude,
            coords.longitude,
            "現在地DEM"
          ).then((ground) => {
            if (!active || requestId !== elevationRequestRef.current) return;
            groundHeightRef.current = ground;
            setPosition((current) => current ? { ...current, height: ground.height } : current);
          }).catch(() => undefined);
        }
      },
      (error) => {
        if (active) setLocationError(`現在地を取得できません：${error.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 1_000, timeout: 15_000 }
    );
    return () => {
      active = false;
      elevationRequestRef.current += 1;
      navigator.geolocation.clearWatch(watchId);
    };
  }, [open, plan]);

  useEffect(() => {
    if (!open || !mapRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setMapSize({
        width: Math.max(1, entry.contentRect.width),
        height: Math.max(1, entry.contentRect.height),
      });
    });
    observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, [open, stage]);

  const distance = plan && position
    ? guidanceDistanceMeters(position, plan.tripod)
    : null;
  const targetBearing = plan && position
    ? guidanceBearingDegrees(position, plan.tripod)
    : null;
  const subjectBearing = plan
    ? guidanceBearingDegrees(plan.tripod, plan.subject)
    : null;
  const elevationDifference = plan && position
    ? plan.tripod.height - position.height
    : null;
  const nearTarget = Boolean(
    distance !== null && position &&
    distance <= Math.max(20, position.accuracyMeters * 1.5)
  );
  const headingError = plan && attitude.headingDegrees !== null
    ? signedAngleDegrees(plan.cameraAzimuthDegrees - attitude.headingDegrees)
    : null;
  const altitudeError = plan && attitude.cameraAltitudeDegrees !== null
    ? plan.cameraAltitudeDegrees - attitude.cameraAltitudeDegrees
    : null;
  const rollError = attitude.rollDegrees;
  const compositionMatches = Boolean(
    stage === "ar" &&
    position && distance !== null &&
    position.accuracyMeters <= 1.5 &&
    distance <= Math.max(.6, position.accuracyMeters) &&
    headingError !== null && Math.abs(headingError) <= 1 &&
    altitudeError !== null && Math.abs(altitudeError) <= 1 &&
    rollError !== null && Math.abs(rollError) <= 1.5
  );
  const phase: GuidancePhase = correctionSaved || compositionMatches
    ? "構図一致"
    : stage === "ar"
      ? "AR調整中"
      : nearTarget
        ? "目標付近"
        : "GPS接近中";

  const center = plan ? mapCenter(position, plan) : null;
  const zoom = guidanceMapZoom(distance ?? 0);
  const targetPixel = plan && center
    ? projectCoordinatesToMapPixel(plan.tripod, center, zoom, mapSize)
    : null;
  const currentPixel = position && center
    ? projectCoordinatesToMapPixel(position, center, zoom, mapSize)
    : null;
  const googleMapUrl = center
    ? `https://maps.google.com/maps?ll=${encodeURIComponent(`${center.latitude},${center.longitude}`)}&z=${zoom}&output=embed&hl=ja&t=m`
    : "about:blank";
  const movement = plan && position && attitude.headingDegrees !== null
    ? movementComponentsMeters(position, plan.tripod, attitude.headingDegrees)
    : null;

  const movementText = useMemo(() => {
    if (!position || !movement || distance === null) {
      return "位置・方位センサー待ち";
    }
    if (position.accuracyMeters > 2) {
      const side = movement.rightMeters >= 0 ? "右" : "左";
      const depth = movement.forwardMeters >= 0 ? "前" : "後ろ";
      return `GPS精度±${position.accuracyMeters.toFixed(1)}m：${side}・${depth}方向へ調整`;
    }
    const useCentimeters = position.accuracyMeters <= .5 && distance < 2;
    const scale = useCentimeters ? 100 : 1;
    const unit = useCentimeters ? "cm" : "m";
    return [
      `${movement.rightMeters >= 0 ? "右" : "左"} ${Math.abs(movement.rightMeters * scale).toFixed(useCentimeters ? 0 : 1)}${unit}`,
      `${movement.forwardMeters >= 0 ? "前" : "後ろ"} ${Math.abs(movement.forwardMeters * scale).toFixed(useCentimeters ? 0 : 1)}${unit}`,
    ].join(" / ");
  }, [distance, movement, position]);

  if (!open || !plan) return null;

  async function startAr(): Promise<void> {
    setSensorError("");
    stopGuidanceSensors();
    try {
      const orientationGranted = await requestOrientationPermission();
      if (!orientationGranted) {
        throw new Error("方位・傾きセンサーが許可されませんでした");
      }
      const handleOrientation = (rawEvent: DeviceOrientationEvent) => {
        const event = rawEvent as WebKitOrientationEvent;
        const heading = typeof event.webkitCompassHeading === "number"
          ? event.webkitCompassHeading
          : event.alpha === null
            ? null
            : normalizeDegrees(360 - event.alpha);
        setAttitude({
          headingDegrees: heading,
          cameraAltitudeDegrees: cameraAltitudeFromOrientation(event),
          rollDegrees: event.gamma,
          absolute: Boolean(event.absolute || event.webkitCompassHeading !== undefined),
        });
      };
      orientationHandlerRef.current = handleOrientation;
      window.addEventListener("deviceorientationabsolute", handleOrientation);
      window.addEventListener("deviceorientation", handleOrientation);
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("カメラはHTTPSまたはlocalhostでのみ利用できます");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
      setStage("ar");
    } catch (error) {
      stopGuidanceSensors();
      setSensorError(error instanceof Error ? error.message : String(error));
    }
  }

  function backToGps(): void {
    stopGuidanceSensors();
    setCameraReady(false);
    setAttitude(EMPTY_ATTITUDE);
    setStage("gps");
  }

  function saveCurrentCorrection(activePlan: GuidancePlan): void {
    if (
      !position ||
      position.accuracyMeters > 3 ||
      attitude.headingDegrees === null ||
      attitude.cameraAltitudeDegrees === null
    ) return;
    const offsets = localOffsetsMeters(activePlan.calculatedTripod, position);
    const actualTripod = {
      latitude: position.latitude,
      longitude: position.longitude,
      height: position.height,
      label: "現地確認済み三脚位置",
    };
    const expectedAzimuth = guidanceBearingDegrees(actualTripod, activePlan.subject);
    const expectedAltitude = cameraAltitudeToSubjectDegrees(
      actualTripod,
      activePlan.subject,
      activePlan.lensCenterHeightMeters
    );
    const correction: FieldCorrection = {
      id: `${activePlan.id}-${Date.now()}`,
      planId: activePlan.id,
      spotKey: planSpotKey(activePlan),
      calculatedTripod: activePlan.calculatedTripod,
      actualTripod,
      eastOffsetMeters: offsets.eastMeters,
      northOffsetMeters: offsets.northMeters,
      elevationCorrectionMeters: position.height - activePlan.calculatedTripod.height,
      azimuthCorrectionDegrees: signedAngleDegrees(
        attitude.headingDegrees - expectedAzimuth
      ),
      altitudeCorrectionDegrees:
        attitude.cameraAltitudeDegrees - expectedAltitude,
      lensCenterHeightMeters: activePlan.lensCenterHeightMeters,
      targetLabel: activePlan.subject.label,
      compositionTitle: activePlan.title,
      gpsAccuracyMeters: position.accuracyMeters,
      savedAtIso: new Date().toISOString(),
    };
    saveFieldCorrection(correction);
    setCorrectionSaved(true);
    onCorrectionSaved(correction, activePlan);
  }

  const canSaveCorrection = Boolean(
    position &&
    position.accuracyMeters <= 3 &&
    attitude.headingDegrees !== null &&
    attitude.cameraAltitudeDegrees !== null
  );

  return (
    <section className={`tripod-guidance-screen stage-${stage}`} aria-label="三脚ポイントへ誘導">
      <header className="guidance-header">
        <button type="button" onClick={onClose} aria-label="誘導を終了">‹ 戻る</button>
        <div><strong>三脚ポイントへ誘導</strong><small>{plan.title}</small></div>
        <span className={`guidance-phase phase-${phase}`}>{phase}</span>
      </header>

      {stage === "gps" ? (
        <div className="guidance-gps-content">
          <div className="guidance-map" ref={mapRef}>
            <iframe title="三脚ポイントGPS誘導地図" src={googleMapUrl} loading="eager" />
            <svg aria-hidden="true">
              {currentPixel && targetPixel && <line x1={currentPixel.x} y1={currentPixel.y} x2={targetPixel.x} y2={targetPixel.y} />}
              {currentPixel && <circle className="guidance-current-dot" cx={currentPixel.x} cy={currentPixel.y} r="7" />}
              {targetPixel && <g className="guidance-target-pin" transform={`translate(${targetPixel.x} ${targetPixel.y})`}><path d="M0 18C-3 10-10 5-10-3a10 10 0 1 1 20 0C10 5 3 10 0 18Z"/><circle cy="-3" r="3"/></g>}
            </svg>
            <div className="guidance-map-legend"><span>● 現在位置</span><span>● 目標三脚</span></div>
          </div>

          <div className="guidance-primary-metrics">
            <div><small>目標まで</small><strong>{formatDistance(distance)}</strong></div>
            <div><small>目標方位</small><strong>{headingText(targetBearing)}</strong></div>
            <div><small>GPS精度</small><strong>{position ? `±${position.accuracyMeters.toFixed(1)}m` : "測位待ち"}</strong></div>
          </div>
          <dl className="guidance-detail-list">
            <div><dt>被写体方向</dt><dd>{headingText(subjectBearing)}</dd></div>
            <div><dt>現在地との標高差</dt><dd>{elevationDifference === null ? "標高取得待ち" : `${elevationDifference >= 0 ? "+" : ""}${elevationDifference.toFixed(1)}m`}</dd></div>
            <div><dt>目標標高</dt><dd>{plan.tripod.height.toFixed(2)}m</dd></div>
            <div><dt>レンズ中心高</dt><dd>{plan.lensCenterHeightMeters.toFixed(2)}m</dd></div>
          </dl>
          {locationError && <p className="guidance-error">{locationError}</p>}
          <p className="guidance-accuracy-note">GPSは接近用です。精度が不足している間はセンチメートル値を確定表示しません。</p>
          <button type="button" className="guidance-start-ar" onClick={() => void startAr()}>
            {nearTarget ? "AR調整を開始" : "AR誘導を手動で開始"}
          </button>
          {sensorError && <p className="guidance-error">{sensorError}</p>}
        </div>
      ) : (
        <div className="guidance-ar-content">
          <video ref={videoRef} className="guidance-camera" muted playsInline autoPlay />
          {!cameraReady && <div className="guidance-camera-wait">カメラ起動中…</div>}
          <div className="guidance-ar-overlay">
            <div className="guidance-level-line" style={{ transform: `translate(-50%, -50%) rotate(${-(rollError ?? 0)}deg)` }} />
            <div className="guidance-camera-center"><i /><span>予定カメラ中心</span></div>
            <div className="guidance-subject-marker" style={overlayPosition(plan.subjectAzimuthDegrees, plan.subjectAltitudeDegrees, attitude)}><b>＋</b><span>被写体中心</span></div>
            <div className={`guidance-celestial-marker celestial-${plan.celestialId}`} style={overlayPosition(plan.celestialAzimuthDegrees, plan.celestialAltitudeDegrees, attitude)}><b>{plan.celestialId === "sun" ? "☀" : plan.celestialId === "moon" ? "☾" : "✦"}</b><span>{plan.celestialLabel}</span></div>
            <div className="guidance-direction-arrow" style={{ transform: `rotate(${headingError ?? 0}deg)` }}>↑</div>
            <div className="guidance-ar-readout">
              <strong>{movementText}</strong>
              <span>方位差 {headingError === null ? "--" : `${headingError >= 0 ? "+" : ""}${headingError.toFixed(1)}°`}</span>
              <span>仰角差 {altitudeError === null ? "--" : `${altitudeError >= 0 ? "+" : ""}${altitudeError.toFixed(1)}°`}</span>
              <span>水平差 {rollError === null ? "--" : `${rollError >= 0 ? "+" : ""}${rollError.toFixed(1)}°`}</span>
              <span>レンズ中心高 {plan.lensCenterHeightMeters.toFixed(2)}m</span>
            </div>
          </div>
          <div className="guidance-ar-actions">
            <button type="button" onClick={backToGps}>GPS地図へ戻る</button>
            <button
              type="button"
              className="guidance-save-correction"
              disabled={!canSaveCorrection}
              onClick={() => saveCurrentCorrection(plan)}
            >
              この位置を正解として保存
            </button>
          </div>
          {!attitude.absolute && attitude.headingDegrees !== null && (
            <p className="guidance-sensor-note">方位が相対値です。端末を8の字に動かしてコンパスを校正してください。</p>
          )}
          {position && position.accuracyMeters > 3 && (
            <p className="guidance-save-lock">GPS精度が±3m以内になるまで確定保存しません</p>
          )}
          {sensorError && <p className="guidance-error ar-error">{sensorError}</p>}
        </div>
      )}
    </section>
  );
}
