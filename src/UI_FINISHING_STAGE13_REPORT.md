# AstroSight UI補助と仕上げ Stage13 実施報告

対象: 修正13「Android・iPhone・ブラウザ互換性」  
実施日: 2026-08-02

## 結果

Web版の主要画面、検索画面、検索ダイアログをスマートフォン相当の縦横表示で確認し、横方向のページはみ出しと致命的な画面崩れがない状態にしました。Android向けWeb資産同期と静的ネイティブ検証は成功しています。

Cesium Ionトークンを設定していない検証環境では3D Tilesそのものは読み込めませんでした。この場合に3D表示へ切り替えて空白になる挙動を修正し、2D地図を維持して理由を表示するようにしました。トークンを使用したWebGL・Photorealistic 3D Tilesの実描画、Android/iPhone実機、iOSネイティブビルドは未確認です。

## 実装内容

### Capacitor・Android設定

- `capacitor.config.ts`
  - iOSの`contentInset: "never"`を設定し、CSSのsafe areaと二重に余白を付けない構成にしました。
  - `preferredContentMode: "mobile"`、リンクプレビュー抑止、背景色を設定しました。
- `android/app/src/main/AndroidManifest.xml`
  - メインActivityを縦画面固定にしました。
  - WebGL/Cesium向けにハードウェアアクセラレーションを明示しました。

### セーフエリア・画面回転・モーダル

- `src/App.css`、`src/components/ProjectScreens.css`
  - メイン画面、検索画面、プロジェクト画面、モーダルに上下左右のsafe areaを反映しました。
  - `100dvh`の前に`100vh`フォールバックを追加し、古いSafari/WebViewでも全高を失わないようにしました。
  - アプリ本体の中央配置からCSS transformを除きました。これにより、transform配下の`position: fixed`モーダルが画面回転やフォーカス移動で上へずれる問題を防ぎます。
  - `overflow: clip`を追加し、横向きで入力へフォーカスした際にアプリ本体が内部スクロールする問題を防ぎました。非対応ブラウザでは直前の`overflow: hidden`へフォールバックします。
  - スポット検索ヘッダーにWebKit用backdrop filterを追加しました。

### 3D失敗時の表示継続

- `src/App.tsx`
  - 3D Viewerが未準備または利用不能な状態では3Dモードへ切り替えず、2D地図を維持します。
  - Cesium Ionトークン未設定は設定上の警告として記録し、利用者には2D地図を利用できることを表示します。
  - これにより、3D初期化失敗時も主要画面と地図操作が空白になりません。

### Web API互換性

- `src/search/backgroundSpotSearch.ts`
  - `crypto.randomUUID()`を機能検出して使用します。
  - 未対応環境では`crypto.getRandomValues()`によるUUID生成、さらに最終フォールバックを使用します。
- 既存実装も確認しました。
  - 位置情報: `navigator.geolocation`とPermissions APIを機能検出しています。
  - 全画面: WebKit Fullscreen APIとiPhone Safari向け疑似全画面があります。
  - プレビュー・2D地図: pointer capture、非passive wheel、複数pointerによるピンチ処理があります。
  - CanvasプレビューとSVGオーバーレイはブラウザDOM上で生成を確認しました。

### 自動検証

- `scripts/verify-platform-compatibility.mjs`を追加しました。
- `package.json`へ`verify:platform-compatibility`を追加しました。
- `scripts/run-regression-tests.mjs`へ16番目の互換性契約テストを追加しました。

## ブラウザ確認

| 環境 | 確認内容 | 結果 |
|---|---|---|
| アプリ内Chromium・縦390×844相当 | メイン画面、Canvas/SVG、スポット検索、日時検索ダイアログ、横はみ出し | 成功 |
| アプリ内Chromium・横844×390相当 | メイン画面、スポット検索、日時検索ダイアログのスクロール、横はみ出し、回転後の固定モーダル位置 | 成功 |
| Cesiumトークン未設定時 | 3D切替を拒否し、2D地図・主要画面・理由表示を維持 | 成功 |
| トークン設定済みWebGL・3D Tiles | 最詳細LODを含む実データ描画 | 未確認（検証環境にトークンなし） |

横表示では20:9のアプリ画面を中央に維持します。Androidネイティブ版はManifestで縦固定です。ブラウザ横表示でも検索画面とダイアログは操作可能ですが、iPhone Safari実機での回転・ノッチ形状別確認は未実施です。

## コマンド検証

- `npm test`: 成功（回帰16グループ、計算テスト8件を含む）
- `npm run lint`: 成功（エラー・警告なし）
- `npm run verify:platform-compatibility`: 成功
- `npm run android:sync`: 成功
  - TypeScriptプロジェクトビルド成功
  - Vite production build成功
  - `dist`をCapacitor Android資産へ同期成功
  - `@capacitor/geolocation@8.2.0`を認識
- `npm run verify:android`: 成功
- Vite警告: minify後の主JSチャンクが527.36 kBで500 kBを超えています。ビルド失敗ではありません。

## Android/iOSビルド可否

| 対象 | 状態 | 理由 |
|---|---|---|
| Web production build | 可能・成功 | TypeScriptとVite buildが成功 |
| Capacitor Android sync | 可能・成功 | Androidプロジェクトと同期済み |
| Android APK/AAB Gradle build | この環境では不可 | `java`、`JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`が未設定。Gradleは終了コード9009でJDK不在を報告 |
| Capacitor iOS build | この環境では不可 | Windows環境でXcodeなし。`ios/`プロジェクトと`@capacitor/ios`依存も現時点では未追加 |

Android実機Chrome/WebView/Capacitor、iPhone Safari/WKWebView/Capacitor iOSでのタップ、実ピンチ、スクロール慣性、位置情報許可、WebGL、3D Tilesは未確認です。コード・設定・デスクトップChromiumの範囲で互換性を確認しています。

## 影響範囲

- 主要計算、検索アルゴリズム、精度モードの計算内容は変更していません。
- 画面外周、モーダル配置、端末向け設定、未準備3Dへの切替制御、UUID生成の互換フォールバックだけを変更しました。
- 修正15「コード整理と最終検査」には着手していません。
