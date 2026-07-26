type KsgNativeLocationBridge = {
  openLocationSettings?: () => void | Promise<void>;
};

type WebKitMessageHandler = {
  postMessage: (message: unknown) => void;
};

type LocationSettingsWindow = Window & {
  KSGNative?: KsgNativeLocationBridge;
  webkit?: {
    messageHandlers?: {
      ksgOpenLocationSettings?: WebKitMessageHandler;
    };
  };
};

export type LocationSettingsPlatform = "android" | "ios" | "other";

export function locationSettingsPlatform(
  userAgent = navigator.userAgent
): LocationSettingsPlatform {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  return "other";
}

/**
 * Android/iOSアプリのWebViewへ設定画面を開く要求を渡す。
 * WebブラウザからOS設定を直接開くことは保証されないため、ネイティブ側が
 * 提供する同一ブリッジだけを使用し、利用できない場合はfalseを返す。
 */
export async function openNativeLocationSettings(): Promise<boolean> {
  const runtimeWindow = window as LocationSettingsWindow;
  if (runtimeWindow.KSGNative?.openLocationSettings) {
    await runtimeWindow.KSGNative.openLocationSettings();
    return true;
  }
  const iosHandler =
    runtimeWindow.webkit?.messageHandlers?.ksgOpenLocationSettings;
  if (iosHandler) {
    iosHandler.postMessage({ source: "ksg-world-photo-planner" });
    return true;
  }
  return false;
}

/**
 * Androidのブラウザ／インストール済みPWAでは、ユーザー操作からIntentを
 * 開ける端末がある。失敗する端末では画面内の手順表示を残す。
 */
export function tryOpenAndroidLocationSettings(): boolean {
  if (locationSettingsPlatform() !== "android") return false;
  window.location.href =
    "intent:#Intent;action=android.settings.LOCATION_SOURCE_SETTINGS;end";
  return true;
}

export function locationPermissionInstructions(
  platform = locationSettingsPlatform()
): string {
  if (platform === "android") {
    return "設定で位置情報をONにし、Chromeの「サイトの設定」→「位置情報」でこのサイトを許可してから再試行してください。";
  }
  if (platform === "ios") {
    return "iPhoneの「設定」→「プライバシーとセキュリティ」→「位置情報サービス」で、このアプリまたはSafariの位置情報を許可してから再試行してください。";
  }
  return "ブラウザのサイト権限で位置情報を許可し、端末の位置情報をONにしてから再試行してください。";
}
