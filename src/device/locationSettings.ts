type KsgNativeLocationBridge = {
  openAppSettings?: () => void | Promise<void>;
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

export type LocationSettingsPlatform = "android" | "ios" | "other";

export function locationSettingsPlatform(
  userAgent = navigator.userAgent
): LocationSettingsPlatform {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  return "other";
}

/**
 * Android/iOSアプリのWebViewへ「このアプリ」の設定画面を開く要求を渡す。
 * WebブラウザからOS設定を直接開くことは保証されないため、ネイティブ側が
 * 提供するアプリ個別設定専用ブリッジだけを使用し、利用できない場合はfalseを返す。
 * 端末全体のGPS設定を開く旧ブリッジは、対象アプリを特定できないため使用しない。
 */
export async function openNativeLocationSettings(): Promise<boolean> {
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

export function canOpenNativeLocationSettings(): boolean {
  const runtimeWindow = window as LocationSettingsWindow;
  return Boolean(
    runtimeWindow.KSGNative?.openAppSettings ||
    runtimeWindow.webkit?.messageHandlers?.ksgOpenAppSettings
  );
}

export function isInstalledWebApp(): boolean {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    iosNavigator.standalone === true;
}

export function locationPermissionInstructions(
  platform = locationSettingsPlatform(),
  siteLabel = window.location.host
): string {
  if (platform === "android") {
    return isInstalledWebApp()
      ? `ホーム画面のKSGアイコンを長押し→「アプリ情報」→「権限」→「位置情報」→「アプリの使用中のみ許可」を選んでください。表示されない場合はChromeで対象サイト（${siteLabel}）を開き、サイト情報→「権限」→「位置情報」→「許可」を選んでからホーム画面版を再起動してください。`
      : `Chromeのアドレスバー左にあるサイト情報→「権限」→「位置情報」→「許可」を選んでください。対象サイト：${siteLabel}。`;
  }
  if (platform === "ios") {
    return `Safariのページメニュー→「Webサイトの設定」→「位置情報」→「許可」を選んでください。対象サイト：${siteLabel}。ホーム画面版では「設定」→「プライバシーとセキュリティ」→「位置情報サービス」も確認してください。`;
  }
  return `ブラウザのサイト権限で位置情報を許可してください。対象サイト：${siteLabel}。あわせて端末の位置情報をONにしてから再試行してください。`;
}
