import { Capacitor, registerPlugin } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import type {
  PermissionStatus as NativePermissionStatus,
  Position as NativePosition,
} from "@capacitor/geolocation";

type KsgNativeLocationBridge = {
  openAppSettings?: () => void | Promise<void>;
};

type KsgNativeSettingsPlugin = {
  openAppSettings: () => Promise<void>;
  openLocationSettings: () => Promise<void>;
};

type WebKitMessageHandler = {
  postMessage: (message: unknown) => void;
};

type LocationSettingsWindow = Window & {
  KSGNative?: KsgNativeLocationBridge;
  webkit?: {
    messageHandlers?: {
      ksgOpenAppSettings?: WebKitMessageHandler;
    };
  };
};

const KsgNativeSettings =
  registerPlugin<KsgNativeSettingsPlugin>("KsgNativeSettings");

export type LocationSettingsPlatform = "android" | "ios" | "other";
export type DeviceLocationFailure =
  | "permission-denied"
  | "location-disabled"
  | "timeout"
  | "unavailable";

export type DeviceLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  native: boolean;
  precision: "precise" | "approximate" | "unknown";
};

export class DeviceLocationError extends Error {
  readonly failure: DeviceLocationFailure;

  constructor(failure: DeviceLocationFailure, message: string) {
    super(message);
    this.name = "DeviceLocationError";
    this.failure = failure;
  }
}

export function locationSettingsPlatform(
  userAgent = navigator.userAgent
): LocationSettingsPlatform {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  return "other";
}

/**
 * PWAとネイティブアプリを混同しないため、CapacitorがAndroid上で
 * 実行されている場合だけAndroidアプリ固有の権限APIを使用する。
 */
export function isNativeAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function hasAnyNativeLocationPermission(
  permission: NativePermissionStatus
): boolean {
  return permission.location === "granted" ||
    permission.coarseLocation === "granted";
}

function nativePrecision(
  permission: NativePermissionStatus
): DeviceLocation["precision"] {
  return permission.location === "granted" ? "precise" : "approximate";
}

function nativePluginErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "";
  }
  return typeof error.code === "string" ? error.code : "";
}

function convertNativeLocationError(error: unknown): DeviceLocationError {
  const code = nativePluginErrorCode(error);
  const message = error instanceof Error
    ? error.message
    : "Androidから現在地を取得できませんでした";

  if (code === "OS-PLUG-GLOC-0003") {
    return new DeviceLocationError("permission-denied", message);
  }
  if (
    code === "OS-PLUG-GLOC-0007" ||
    code === "OS-PLUG-GLOC-0009" ||
    code === "OS-PLUG-GLOC-0017"
  ) {
    return new DeviceLocationError("location-disabled", message);
  }
  if (code === "OS-PLUG-GLOC-0010") {
    return new DeviceLocationError("timeout", message);
  }
  return new DeviceLocationError("unavailable", message);
}

async function requestNativeLocationPermission(): Promise<NativePermissionStatus> {
  try {
    const current = await Geolocation.checkPermissions();
    if (hasAnyNativeLocationPermission(current)) return current;

    // Android 12以降はユーザーが「正確」と「おおよそ」を選べる。
    // 両方のaliasを要求し、どちらか一方が許可されれば現在地を利用可能とする。
    const requested = await Geolocation.requestPermissions({
      permissions: ["location", "coarseLocation"],
    });
    if (!hasAnyNativeLocationPermission(requested)) {
      throw new DeviceLocationError(
        "permission-denied",
        "Androidの位置情報権限が拒否されました"
      );
    }
    return requested;
  } catch (error) {
    if (error instanceof DeviceLocationError) throw error;
    throw convertNativeLocationError(error);
  }
}

async function nativeCurrentPosition(
  options: PositionOptions
): Promise<DeviceLocation> {
  const permission = await requestNativeLocationPermission();
  let position: NativePosition;
  try {
    position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: options.enableHighAccuracy,
      timeout: options.timeout,
      maximumAge: options.maximumAge,
      // Play Servicesを利用できない端末でもAndroid標準GPSへ切り替える。
      enableLocationFallback: true,
    });
  } catch (error) {
    throw convertNativeLocationError(error);
  }

  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    native: true,
    precision: nativePrecision(permission),
  };
}

function webCurrentPosition(options: PositionOptions): Promise<DeviceLocation> {
  if (!navigator.geolocation) {
    return Promise.reject(
      new DeviceLocationError(
        "unavailable",
        "この端末またはブラウザでは現在地を取得できません"
      )
    );
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          native: false,
          precision: "unknown",
        });
      },
      (error) => {
        const failure: DeviceLocationFailure =
          error.code === error.PERMISSION_DENIED
            ? "permission-denied"
            : error.code === error.TIMEOUT
              ? "timeout"
              : "unavailable";
        reject(new DeviceLocationError(failure, error.message));
      },
      options
    );
  });
}

/**
 * Androidネイティブ版ではOSの実行時権限を要求し、Web/PWAでは従来の
 * Geolocation APIを使用する。同じ戻り値へ正規化して地図側の処理を共通化する。
 */
export async function getDeviceCurrentPosition(
  options: PositionOptions
): Promise<DeviceLocation> {
  return isNativeAndroidApp()
    ? nativeCurrentPosition(options)
    : webCurrentPosition(options);
}

/**
 * Android/iOSアプリのWebViewへ「このアプリ」の設定画面を開く要求を渡す。
 * WebブラウザからOS設定を直接開くことは保証されないため、ネイティブ側が
 * 提供するアプリ個別設定専用ブリッジだけを使用する。
 */
export async function openNativeLocationSettings(): Promise<boolean> {
  if (isNativeAndroidApp()) {
    await KsgNativeSettings.openAppSettings();
    return true;
  }

  const runtimeWindow = window as LocationSettingsWindow;
  if (runtimeWindow.KSGNative?.openAppSettings) {
    await runtimeWindow.KSGNative.openAppSettings();
    return true;
  }
  const iosHandler =
    runtimeWindow.webkit?.messageHandlers?.ksgOpenAppSettings;
  if (iosHandler) {
    iosHandler.postMessage({ source: "ksg-world-photo-planner" });
    return true;
  }
  return false;
}

export async function openNativeSystemLocationSettings(): Promise<boolean> {
  if (!isNativeAndroidApp()) return false;
  await KsgNativeSettings.openLocationSettings();
  return true;
}

export function canOpenNativeLocationSettings(): boolean {
  if (isNativeAndroidApp()) return true;
  const runtimeWindow = window as LocationSettingsWindow;
  return Boolean(
    runtimeWindow.KSGNative?.openAppSettings ||
    runtimeWindow.webkit?.messageHandlers?.ksgOpenAppSettings
  );
}

export function isInstalledWebApp(): boolean {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  // manifestのstart_urlにも付与した印を使い、display-mode判定が不安定な
  // Androidホーム画面版でもインストール向け案内を確実に選択する。
  const installedStartMarker =
    new URLSearchParams(window.location.search).get("source") === "installed";
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    iosNavigator.standalone === true ||
    installedStartMarker;
}

export async function geolocationPermissionState(): Promise<
  PermissionState | "unsupported"
> {
  if (isNativeAndroidApp()) {
    try {
      const permission = await Geolocation.checkPermissions();
      return hasAnyNativeLocationPermission(permission)
        ? "granted"
        : permission.location === "denied"
          ? "denied"
          : "prompt";
    } catch {
      return "unsupported";
    }
  }
  if (!navigator.permissions?.query) return "unsupported";
  try {
    return (
      await navigator.permissions.query({
        name: "geolocation",
      })
    ).state;
  } catch {
    // Safariなど照会未対応の環境では、getCurrentPosition本体の結果で判定する。
    return "unsupported";
  }
}

export function locationPermissionInstructions(
  platform = locationSettingsPlatform(),
  siteLabel = window.location.host
): string {
  if (isNativeAndroidApp()) {
    return "Android設定→「アプリ」→「KSG World Photo Planner」→「権限」→「位置情報」で「アプリの使用中のみ許可」を選んでください。正確な三脚位置には「正確な位置情報」もONにしてください。";
  }
  if (platform === "android") {
    return isInstalledWebApp()
      // AndroidのPWAは通常アプリの権限欄ではなく、Chromeのサイト権限として
      // 位置情報を管理する構成があることを最初に明記する。
      ? `このホーム画面版はWebアプリのため、Androidの「このアプリの権限」に位置情報が表示されない場合があります。Chromeで「${siteLabel}」を開き、アドレスバー左のサイト情報→「権限」→「位置情報」→「許可」にしてください。見つからない場合はChromeの︙→「設定」→「サイトの設定」→「位置情報」→「${siteLabel}」を確認します。あわせてAndroid設定→「位置情報」→「位置情報を使用」をONにしてください。`
      : `Chromeのアドレスバー左にあるサイト情報→「権限」→「位置情報」→「許可」を選んでください。対象サイト：${siteLabel}。`;
  }
  if (platform === "ios") {
    return `Safariのページメニュー→「Webサイトの設定」→「位置情報」→「許可」を選んでください。対象サイト：${siteLabel}。ホーム画面版では「設定」→「プライバシーとセキュリティ」→「位置情報サービス」も確認してください。`;
  }
  return `ブラウザのサイト権限で位置情報を許可してください。対象サイト：${siteLabel}。あわせて端末の位置情報をONにしてから再試行してください。`;
}
