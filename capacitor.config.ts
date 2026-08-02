import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "jp.ksg.worldphotoplanner",
  appName: "AstroSight",
  webDir: "dist",
  // 既存の縦長撮影UIをAndroidでも維持するため、WebViewの背景色を
  // 起動画面と同じ暗色に固定し、初回描画時の白い点滅を防ぐ。
  backgroundColor: "#05070a",
  android: {
    allowMixedContent: false,
  },
  ios: {
    // CSSのsafe-area-insetでノッチを処理するため、WKWebView側の自動余白は重ねない。
    contentInset: "never",
    preferredContentMode: "mobile",
    allowsLinkPreview: false,
    backgroundColor: "#05070a",
  },
};

export default config;
