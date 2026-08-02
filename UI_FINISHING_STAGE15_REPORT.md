# AstroSight UI補助と仕上げ Stage15 最終検査報告

対象: 修正15「コード整理と最終検査」  
実施日: 2026-08-02

## 結論

Stage08・10・11・12・13までの機能を維持したまま、未使用コード・資産・依存関係と本番デバッグ出力を整理しました。TypeScriptの3構成すべてで`strict: true`を有効にし、全17グループの回帰テスト、lint、Web production build、Capacitor Android同期、主要画面のブラウザ操作確認に成功しました。

トークン・JDK・Android SDK・Xcode・実機を必要とする確認はこの環境では完了できないため、「未確認事項」に明記しています。

## コード整理

### 削除した未使用コード・資産

- `src/components/FocalLengthPanel.tsx`
  - 現在の`TopSettingsBar`へ置き換え済みで、どこからもimportされていない旧試作UIでした。
- `src/components/MobileBottomNav.tsx`
  - どこからもimportされていない旧試作ナビゲーションでした。
- `src/assets/react.svg`
- `src/assets/vite.svg`
- `src/assets/hero.png`
  - 3ファイルともソース・HTML・CSSから参照されていませんでした。
- `src/App.css`
  - 上記2コンポーネントだけが使用していた焦点距離パネル・下部ナビゲーション用CSSを削除しました。
  - production CSSは約94.5 kBから91.9 kBになりました。

過去の修正報告Markdownは実行コードではなく変更履歴のため削除していません。

### 依存関係

- `resium`を削除しました。アプリはCesium APIを直接使用しており、Resiumのimportはありませんでした。
- `ol`を削除しました。OpenLayersのimportはありませんでした。
- npmにより関連する未使用推移依存19パッケージも`node_modules`から除去され、`package-lock.json`を更新しました。
- `npm ls --depth=0`: 成功。直接依存10件、開発依存11件に不整合はありません。

### 型・ログ・コメント

- `tsconfig.app.json`、`tsconfig.node.json`、`tsconfig.server.json`へ`strict: true`を明示しました。
- strict指定で3構成すべてTypeScriptエラー0です。
- production sourceの明示的`any`: 0件です。
- 到達不能な`.ts`・`.tsx`・`.css`モジュール: 0件です。型宣言`.d.ts`は別扱いで確認しています。
- スポット検索完了ごとの`console.info`デバッグ出力を削除しました。性能値は既存の`onPerformance`経由で必要な処理へ渡されます。
- production sourceの`console.log`・`console.debug`・`console.info`: 0件です。
- `console.warn`・`console.error`は取得失敗やフォールバックの運用診断に必要なものだけを維持しました。
- `TODO`・`FIXME`・`HACK`: 0件です。

### 再混入防止

- `scripts/verify-final-cleanup.mjs`を追加しました。
  - strict設定
  - 削除対象ファイル・依存関係
  - `main.tsx`からのソース到達可能性
  - 明示的`any`
  - 本番デバッグログ
  - 未完了マーカー
  を自動確認します。
- `npm run verify:final-cleanup`を追加しました。
- 全回帰テストへ17番目の最終整理契約テストとして組み込みました。

## 最終検証結果

| 項目 | 結果 |
|---|---|
| `npm test` | 成功。17グループ、計算テスト8件を含む |
| TypeScript strict build | 成功。エラー0 |
| `npm run lint` | 成功。エラー・警告0 |
| `npm run build` | 成功 |
| `npm run verify:final-cleanup` | 成功 |
| `npm run android:sync` | 成功 |
| `npm run verify:android` | 成功 |
| `npm ls --depth=0` | 成功 |
| `dist/index.html`とAndroid同期資産 | SHA-256一致 |

production出力:

- CSS: 91.89 kB（gzip 18.82 kB）
- main JavaScript: 527.31 kB（gzip 171.50 kB）
- Viteの500 kB超過警告は残っていますが、ビルド失敗ではありません。

## 既存機能の維持確認

自動回帰と静的配線検証で次を確認しました。

- 太陽・月・天の川・北極星の表示配線
- 共通カメラ投影と画角内判定
- 被写体方向の横切り検索
- Karney測地線の逆解・順解
- 三脚候補検索、キャッシュキー、検索世代競合防止、進捗・残り時間
- DEMとGoogle 3D遮蔽の状態管理
- 遮蔽理由表示と失敗時フォールバック
- 標準／最高精度の初期値と説明
- Google Maps URL解析
- Android/iPhone/ブラウザ互換性契約

ブラウザで次を操作確認しました。

- 390×844相当のメイン画面、Canvas、SVG、横はみ出しなし
- ハンバーガーメニューと「精度設定」
- 「標準」初期値、「最高精度」への切替、標準への復元
- スポット検索と「日時・構図候補も検索」
- 「見通し確認済みのみ」の表示、ON/OFF
- 天体通過日時検索ダイアログ
- 844×390相当での固定モーダルと横はみ出しなし
- Cesium Ionトークン未設定時に3D空白へ切り替えず2Dを維持
- ブラウザコンソールエラー0。トークン未設定の警告1件のみ

## 影響範囲

- 計算式、検索条件、検索順序、DEM/3D判定、精度モードの処理内容は変更していません。
- 削除対象はimport・参照がないファイル、専用CSS、未使用依存、本番デバッグ表示だけです。
- strict化でソース変更を必要とする型エラーは発生しませんでした。

## 未確認・未解決事項

- 検証環境に`VITE_CESIUM_ION_TOKEN`がないため、トークン設定済みCesium WebGL・Google Photorealistic 3D Tilesの実描画と最詳細LODは未確認です。
- Android実機Chrome/WebView/Capacitor、iPhone Safari/WKWebView/Capacitor iOSでの実タッチ、位置情報許可、端末GPU、3D Tilesは未確認です。
- Android APK/AAB buildはJDK、`JAVA_HOME`、Android SDK環境変数がないため未実施です。Web資産同期とネイティブ静的検証までは成功しています。
- iOS buildはWindows環境、Xcodeなし、`ios/`プロジェクトと`@capacitor/ios`未追加のため未実施です。
- production main JavaScriptの527.31 kB警告が残っています。将来の読み込み時間改善では画面単位のdynamic importを検討できますが、今回の機能維持を優先して分割方法は変更していません。
- `package.json`のversionは`0.0.0`のままです。販売用の正式なバージョン番号はリリース時に決定する必要があります。
- 外部APIと実データを使用する長時間検索・DEM・天気・OSM・Netlify Functionsの本番エンドツーエンド試験は、認証情報と本番環境が必要なため未実施です。
