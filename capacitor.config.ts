import type { CapacitorConfig } from "@capacitor/cli";

// appId / webDir は android/app/build.gradle の applicationId・Web資産の
// 出力先（vite build成果物）と一致させている。
const config: CapacitorConfig = {
  appId: "jp.astrosight.app",
  appName: "AstroSight",
  webDir: "dist",
  backgroundColor: "#05070a",
  // 2026-09-01追記: 現時点ではWeb版（PWA）のみの提供だが、将来Capacitorで
  // ネイティブアプリ化した際に備えて先に設定しておく。既定ではWKWebView/
  // Android WebViewはアプリ自身のオリジン以外への遷移を許可しないため、
  // Cesium ionのOAuth認証（src/precision/cesiumIonConnection.ts）で
  // location.hrefによりion.cesium.com等へ遷移する処理がブロックされたり、
  // 意図せずSafari/Chromeへ切り離されて認証状態を見失ったりする。
  // 認証フローで実際に遷移する3ドメイン（認証画面・トークン交換・
  // このアプリ自身の配信元）をあらかじめ許可しておく。
  server: {
    allowNavigation: [
      "ion.cesium.com",
      "api.cesium.com",
      "astrosight.pages.dev",
    ],
  },
  ios: {
    // safe areaはCSS側（env(safe-area-inset-*)）で管理するため、
    // WKWebViewの自動contentInsetは無効化して二重に余白が付かないようにする。
    contentInset: "never",
    preferredContentMode: "mobile",
    // 撮影地点のURL等をタップした際、リンクプレビューでアプリ外へ
    // 離脱しないようにする。
    allowsLinkPreview: false,
    backgroundColor: "#05070a",
  },
  android: {
    // HTTPS以外のコンテンツ読み込みを禁止し、Android WebViewをHTTPS限定にする。
    allowMixedContent: false,
    backgroundColor: "#05070a",
  },
};

export default config;
