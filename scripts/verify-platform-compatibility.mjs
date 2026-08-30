import fs from "node:fs";

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const capacitor = read("capacitor.config.ts");
const index = read("index.html");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const appCss = read("src/App.css");
const projectCss = read("src/components/ProjectScreens.css");
const fullscreen = read("src/ui/fullscreen.ts");
const previewGesture = read("src/components/PreviewGestureLayer.tsx");
const mapGesture = read("src/components/Map2DInteractionLayer.tsx");
const location = read("src/device/locationSettings.ts");
const backgroundSearch = read("src/search/backgroundSpotSearch.ts");
const app = read("src/App.tsx");
const userFeedback = read("src/errors/userFeedback.ts");

const required = [
  [index, "viewport-fit=cover", "viewport-fit cover"],
  [index, "apple-mobile-web-app-capable", "iOS standalone metadata"],
  [capacitor, 'contentInset: "never"', "WKWebView CSS-managed insets"],
  [capacitor, 'preferredContentMode: "mobile"', "WKWebView mobile content mode"],
  [capacitor, "allowMixedContent: false", "Android HTTPS-only WebView"],
  [manifest, 'android:hardwareAccelerated="true"', "Android WebGL hardware acceleration"],
  [manifest, 'android:screenOrientation="portrait"', "Android portrait lock"],
  [manifest, "android.permission.INTERNET", "Android network permission"],
  [manifest, "android.permission.ACCESS_FINE_LOCATION", "Android precise location permission"],
  [appCss, "width: min(100vw, calc(100vh * .45));", "vh width fallback"],
  [appCss, "height: 100vh;", "vh height fallback"],
  [appCss, "height: 100dvh;", "dynamic viewport height"],
  [appCss, "env(safe-area-inset-top)", "top safe area"],
  [appCss, "env(safe-area-inset-right)", "right safe area"],
  [appCss, "env(safe-area-inset-bottom)", "bottom safe area"],
  [appCss, "env(safe-area-inset-left)", "left safe area"],
  [appCss, "inset-inline: 0;", "transform-free centered application shell"],
  [appCss, "overflow: clip;", "rotation focus-scroll guard"],
  [projectCss, "calc(100vh * .45)", "project screen vh fallback"],
  [projectCss, "safe-area-inset-top", "project screen notch protection"],
  [fullscreen, "webkitRequestFullscreen", "WebKit fullscreen API"],
  [fullscreen, "ios-pseudo-fullscreen", "iPhone fullscreen fallback"],
  [previewGesture, "setPointerCapture", "preview pointer capture"],
  [previewGesture, 'passive: false', "preview non-passive wheel"],
  [mapGesture, "setPointerCapture", "map pointer capture"],
  [mapGesture, 'passive: false', "map non-passive wheel"],
  [location, "navigator.permissions?.query", "Safari permissions API guard"],
  [location, "if (!navigator.geolocation)", "geolocation API guard"],
  [backgroundSearch, "runtimeCrypto?.randomUUID", "randomUUID compatibility guard"],
  [backgroundSearch, "runtimeCrypto?.getRandomValues", "secure UUID fallback"],
  [userFeedback, "2D地図は利用できます", "3D initialization fallback"],
  [app, "viewer.useDefaultRenderLoop = false", "preview-only Cesium idle guard"],
  [app, 'className="map-2d-stage active"', "lower Google Maps remains visible while preview initializes"],
  [app, "<canvas", "Canvas preview"],
  [app, "<svg", "SVG overlay"],
];

for (const [source, expected, label] of required) {
  if (!source.includes(expected)) {
    throw new Error(`platform compatibility requirement is missing: ${label}`);
  }
}

if (app.includes('data-tutorial-id="map-mode-3d"')) {
  throw new Error("removed lower-map 3D activation control is still present");
}

if (!appCss.includes(".preview-gesture-layer") || !appCss.includes("touch-action: none")) {
  throw new Error("preview touch-action isolation is missing");
}
if (!appCss.includes(".map-2d-pan-layer") || !appCss.includes("touch-action: none")) {
  throw new Error("map touch-action isolation is missing");
}

const iosProjectPresent = fs.existsSync(
  new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url),
);

console.log(JSON.stringify({
  androidPortraitLocked: true,
  androidHardwareAccelerated: true,
  browserSafeAreas: true,
  legacyViewportFallback: true,
  touchAndPinchWiring: true,
  iosConfigurationPrepared: true,
  iosProjectPresent,
}));
