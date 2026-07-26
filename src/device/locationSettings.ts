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
