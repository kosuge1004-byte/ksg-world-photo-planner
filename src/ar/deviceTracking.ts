import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import type { Position as NativePosition } from "@capacitor/geolocation";

export type ArDeviceLocation = {
  latitude: number;
  longitude: number;
  altitudeMeters: number | null;
  accuracyMeters: number;
  altitudeAccuracyMeters: number | null;
  headingDegrees: number | null;
  speedMetersPerSecond: number | null;
  source: "capacitor-geolocation" | "web-geolocation";
  timestampMs: number;
};

export type ArDeviceOrientation = {
  headingDegrees: number | null;
  alphaDegrees: number | null;
  betaDegrees: number | null;
  gammaDegrees: number | null;
  absolute: boolean;
  source: "webkit-compass" | "deviceorientationabsolute" | "deviceorientation";
  timestampMs: number;
};

export type ArTrackingSnapshot = {
  location: ArDeviceLocation | null;
  orientation: ArDeviceOrientation | null;
};

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type WebkitDeviceOrientationEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * W3C DeviceOrientation Euler anglesから、画面上端が向く水平方位を求める。
 * alphaだけを方位として使うと端末を傾けた時に大きくずれるため、beta/gammaも使う。
 */
function compassHeadingFromEuler(
  alphaDegrees: number,
  betaDegrees: number,
  gammaDegrees: number
): number | null {
  const degToRad = Math.PI / 180;
  const alpha = alphaDegrees * degToRad;
  const beta = betaDegrees * degToRad;
  const gamma = gammaDegrees * degToRad;
  const cA = Math.cos(alpha);
  const sA = Math.sin(alpha);
  const sB = Math.sin(beta);
  const cG = Math.cos(gamma);
  const sG = Math.sin(gamma);
  const x = -cA * sG - sA * sB * cG;
  const y = -sA * sG + cA * sB * cG;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12)) {
    return null;
  }
  return normalizeHeading(Math.atan2(x, y) / degToRad);
}

export async function requestArOrientationPermissionFromUserGesture(): Promise<
  "granted" | "denied" | "not-required"
> {
  if (typeof DeviceOrientationEvent === "undefined") return "denied";
  const orientationType = DeviceOrientationEvent as DeviceOrientationEventWithPermission;
  if (typeof orientationType.requestPermission !== "function") return "not-required";
  try {
    return await orientationType.requestPermission();
  } catch {
    return "denied";
  }
}

function convertNativePosition(position: NativePosition): ArDeviceLocation {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    altitudeMeters: finiteOrNull(position.coords.altitude),
    accuracyMeters: position.coords.accuracy,
    altitudeAccuracyMeters: finiteOrNull(position.coords.altitudeAccuracy),
    headingDegrees: finiteOrNull(position.coords.heading),
    speedMetersPerSecond: finiteOrNull(position.coords.speed),
    source: "capacitor-geolocation",
    timestampMs: position.timestamp,
  };
}

function convertWebPosition(position: GeolocationPosition): ArDeviceLocation {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    altitudeMeters: finiteOrNull(position.coords.altitude),
    accuracyMeters: position.coords.accuracy,
    altitudeAccuracyMeters: finiteOrNull(position.coords.altitudeAccuracy),
    headingDegrees: finiteOrNull(position.coords.heading),
    speedMetersPerSecond: finiteOrNull(position.coords.speed),
    source: "web-geolocation",
    timestampMs: position.timestamp,
  };
}

export async function startArLocationTracking(
  onLocation: (location: ArDeviceLocation) => void,
  onError: (message: string) => void
): Promise<() => void> {
  if (Capacitor.isNativePlatform()) {
    try {
      const permission = await Geolocation.checkPermissions();
      if (permission.location !== "granted" && permission.coarseLocation !== "granted") {
        const requested = await Geolocation.requestPermissions({
          permissions: ["location", "coarseLocation"],
        });
        if (requested.location !== "granted" && requested.coarseLocation !== "granted") {
          onError("位置情報権限が許可されていません");
          return () => undefined;
        }
      }

      let active = true;
      const watchId = await Geolocation.watchPosition(
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 1000,
          enableLocationFallback: true,
        },
        (position, error) => {
          if (!active) return;
          if (error) {
            onError(error.message || "現在地を更新できませんでした");
            return;
          }
          if (position) onLocation(convertNativePosition(position));
        }
      );
      return () => {
        active = false;
        void Geolocation.clearWatch({ id: watchId });
      };
    } catch (error) {
      onError(error instanceof Error ? error.message : "現在地を取得できませんでした");
      return () => undefined;
    }
  }

  if (!navigator.geolocation) {
    onError("この端末またはブラウザでは現在地を取得できません");
    return () => undefined;
  }

  const watchId = navigator.geolocation.watchPosition(
    (position) => onLocation(convertWebPosition(position)),
    (error) => onError(error.message || "現在地を更新できませんでした"),
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 1000,
    }
  );
  return () => navigator.geolocation.clearWatch(watchId);
}

export function startArOrientationTracking(
  onOrientation: (orientation: ArDeviceOrientation) => void,
  onError: (message: string) => void
): () => void {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") {
    onError("この端末では方位・姿勢センサーを利用できません");
    return () => undefined;
  }

  const absoluteSupported = "ondeviceorientationabsolute" in window;
  const eventName: "deviceorientationabsolute" | "deviceorientation" = absoluteSupported
    ? "deviceorientationabsolute"
    : "deviceorientation";

  const listener = (rawEvent: Event) => {
    const event = rawEvent as WebkitDeviceOrientationEvent;
    const alpha = finiteOrNull(event.alpha);
    const beta = finiteOrNull(event.beta);
    const gamma = finiteOrNull(event.gamma);
    const webkitHeading = finiteOrNull(event.webkitCompassHeading);
    let heading: number | null = webkitHeading !== null ? normalizeHeading(webkitHeading) : null;
    let source: ArDeviceOrientation["source"] = webkitHeading !== null
      ? "webkit-compass"
      : eventName;

    if (heading === null && alpha !== null && beta !== null && gamma !== null) {
      heading = compassHeadingFromEuler(alpha, beta, gamma);
    }

    onOrientation({
      headingDegrees: heading,
      alphaDegrees: alpha,
      betaDegrees: beta,
      gammaDegrees: gamma,
      absolute: event.absolute === true || eventName === "deviceorientationabsolute" || webkitHeading !== null,
      source,
      timestampMs: performance.timeOrigin + performance.now(),
    });
  };

  window.addEventListener(eventName, listener, true);
  return () => window.removeEventListener(eventName, listener, true);
}
