import type { CapacitorConfig } from "@capacitor/cli";

// appId / webDir は android/app/build.gradle の applicationId・Web資産の
// 出力先（vite build成果物）と一致させている。
const config: CapacitorConfig = {
  appId: "jp.astrosight.app",
  appName: "AstroSight",
  webDir: "dist",
  backgroundColor: "#05070a",
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
