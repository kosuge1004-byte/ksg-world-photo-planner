import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = read("android/app/src/main/AndroidManifest.xml");
const mainActivity = read(
  "android/app/src/main/java/jp/astrosight/app/MainActivity.java"
);
const settingsPlugin = read(
  "android/app/src/main/java/jp/astrosight/app/AstroSightNativeSettingsPlugin.java"
);
const locationSource = read("src/device/locationSettings.ts");
const capacitorConfig = read("capacitor.config.ts");

// Android設定の「権限」に位置情報を表示させるため、Manifestの明示宣言を検査する。
assert(
  manifest.includes("android.permission.ACCESS_COARSE_LOCATION"),
  "ACCESS_COARSE_LOCATIONがAndroidManifestにありません"
);
assert(
  manifest.includes("android.permission.ACCESS_FINE_LOCATION"),
  "ACCESS_FINE_LOCATIONがAndroidManifestにありません"
);
assert(
  manifest.includes('android.hardware.location.gps"') &&
    manifest.includes('android:required="false"'),
  "GPS非搭載端末を不必要に除外しないuses-feature設定がありません"
);

// ローカルプラグインはBridge生成前に登録しないとJavaScriptから呼び出せない。
const registration = mainActivity.indexOf(
  "registerPlugin(AstroSightNativeSettingsPlugin.class)"
);
const bridgeCreation = mainActivity.indexOf("super.onCreate(savedInstanceState)");
assert(
  registration >= 0 && bridgeCreation >= 0 && registration < bridgeCreation,
  "AstroSightNativeSettingsPluginがBridge生成前に登録されていません"
);
assert(
  settingsPlugin.includes('@CapacitorPlugin(name = "AstroSightNativeSettings")') &&
    settingsPlugin.includes("Settings.ACTION_APPLICATION_DETAILS_SETTINGS"),
  "AstroSightアプリ固有の設定画面を開くネイティブプラグインが不完全です"
);
assert(
  settingsPlugin.includes("Settings.ACTION_LOCATION_SOURCE_SETTINGS"),
  "Android端末全体の位置情報設定を開く処理がありません"
);

// 現在地ボタンがWeb APIへ戻らず、Androidの実行時権限要求を通ることを検査する。
assert(
  locationSource.includes("Geolocation.checkPermissions()") &&
    locationSource.includes("Geolocation.requestPermissions(") &&
    locationSource.includes('permissions: ["location", "coarseLocation"]') &&
    locationSource.includes("Geolocation.getCurrentPosition("),
  "Capacitor Geolocationの権限要求または現在地取得が接続されていません"
);
assert(
  locationSource.includes("Capacitor.isNativePlatform()") &&
    locationSource.includes('Capacitor.getPlatform() === "android"'),
  "Androidネイティブ版とPWA版の分岐がありません"
);
assert(
  capacitorConfig.includes('appId: "jp.astrosight.app"') &&
    existsSync(
      resolve(
        root,
        "android/app/src/main/assets/public/assets"
      )
    ),
  "Capacitor設定またはAndroidへ同期済みのWeb資産がありません"
);

console.log("Android native location verification: PASS");
