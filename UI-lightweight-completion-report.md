# AstroSight UI軽量化・操作簡素化 完了報告

作成日: 2026-08-30

## 結論

下側表示を Google Maps 2D 専用（通常地図／航空写真）へ変更し、3D 表示は上側の三脚視点固定型プレビューだけに整理しました。ECEF/WGS84、DEM、ジオイド、CameraModel、天体位置、大気差・屈折、三脚候補の収束・精密化、round-trip 判定、カメラ高を含む精度系コードは変更していません。

## 1. 変更ファイル一覧

変更:

- `src/App.tsx`
- `src/App.css`
- `src/cesium/previewSnapshot.ts`
- `src/components/PlacementConfirmDialog.tsx`
- `src/components/PreviewChrome.tsx`
- `src/components/PreviewGestureLayer.tsx`
- `src/components/SpotSearchScreen.tsx`
- `scripts/verify-occlusion-state.mjs`
- `scripts/verify-performance-lifecycle.mjs`
- `scripts/verify-person-display.mjs`
- `scripts/verify-platform-compatibility.mjs`
- `scripts/verify-search-generation.mjs`
- `scripts/verify-search-progress.mjs`
- `scripts/verify-tripod-candidate-rendering.mjs`

削除:

- `src/cesium/celestialMap.ts`
- `src/cesium/connectionLine.ts`
- `src/cesium/foregroundObject.ts`
- `src/cesium/mapMeasurement.ts`
- `src/cesium/mapPlacement.ts`
- `src/cesium/subjectEdit.ts`
- `src/components/SubjectEditOverlay.tsx`

検証スクリプトは削除せず、下側3Dとスポット検索内の日時・構図候補UIを前提としていた stale contract だけを新仕様へ更新しました。

## 2. 削除した3D機能

- 下側の Cesium／Google Photorealistic 3D Tiles 表示
- 下側の2D／3D切替
- 下側3Dの回転、チルト、自由カメラ、orbit、配置・編集イベント
- 下側3D専用の天体、接続線、人物・前景、計測、配置、被写体編集レンダリング
- 下側3D専用の状態管理と候補描画経路

## 3. 維持した3D機能

- 上側の Google Photorealistic 3D Tiles 撮影プレビュー
- 三脚位置をカメラ原点とする既存の撮影プレビュー投影
- CameraModel と既存の画角・焦点距離・カメラ高処理
- 深度付き3D surface pick による正式な被写体点の取得
- 三脚候補選択時に、その候補位置からプレビューを再生成する経路

## 4. 2D地図の変更

- 下側を常時 Google Maps 2D に固定
- 「通常地図」と「航空写真」の切替を追加
- 被写体ピン、手動三脚ピン、三脚候補、現在地、距離計測、既存マーカーを2D側へ集約
- 三脚候補の内部計算は3D/ECEF系のまま、結果の緯度経度だけを2D地図へ表示
- 手動三脚および被写体の高さ入力を廃止し、既存のDEM・ジオイド・3D surface処理を使用

## 5. プレビュー操作仕様

- カメラ位置は三脚位置に固定
- 左右パン、上下チルト、ピンチズームを維持
- 正式な被写体位置を指定する「位置指定」モードを追加
- ロール、地平線を傾ける操作、自由移動、orbit、被写体裏側への回り込みは提供しない
- Cesium の常時レンダーループを停止し、プレビュー生成・pick等の必要時に描画

## 6. 被写体3D pick経路

`PreviewChrome` → `PreviewGestureLayer` → `App` → `pickTripodPreviewSurface` → 既存 `pickSceneSurfacePosition` → 既存 `setSubjectPinFromExplicit3dPick` の経路です。三脚視点と同一のカメラ・frustumを再現し、深度が取得できた Photorealistic 3D surface の座標だけを正式点として保存します。高さの手入力やWGS84楕円体への精度低下フォールバックは追加していません。

## 7. スポット検索変更内容

- 場所／被写体を探す検索、履歴、お気に入り、Google Maps URL入力を維持
- スポット検索内の「日時・構図候補も検索」UIと候補結果を削除
- アプリ本体の日時、時間軸、天体検索、日の出・日の入、月出・月没、天の川等は維持
- 精度変更を避けるため、既存計算実装そのものは壊さず、スポット検索UIから到達不能にしています

## 8. 三脚候補計算に変更がないことの確認結果

原本と改修後で SHA-256 を比較し、次の精度関連ファイルがすべて同一であることを確認しました。

- `src/cesium/tripodCandidates.ts`
- `src/cesium/tripodCandidateExactCache.ts`
- `src/cesium/tripodCandidateSeedCache.ts`
- `src/cesium/cameraModelFactory.ts`
- `src/cesium/camera.ts`
- `src/cesium/celestial.ts`
- `src/cesium/gsiElevationClient.ts`
- `src/cesium/gsiDemTileCache.ts`
- `src/cesium/worldTerrain.ts`
- `src/cesium/surfacePicking.ts`
- `src/height/heightResolver.ts`
- `src/geodesy/karneyGeodesic.ts`
- `src/geodesy/terrestrialRefraction.ts`
- `src/geodesy/adaptiveTerrainProfile.ts`
- `src/search/refractionWeather.ts`
- `src/search/refractionWeatherModel.ts`
- `src/apparent/apparentElevation.ts`
- `src/projection/projectionService.ts`
- `src/validation/validationService.ts`
- `src/types/precision.ts`
- `src/types/camera.ts`

三脚候補のround-trip、多交点、標高基準、Terrain、CameraModel共有投影、屈折、Karney測地線の回帰試験もPASSしています。

## 9. 実行したテスト

- `npm run lint`: 成功（エラー0、既存警告のみ）
- `npm test`: 成功（Regression suite PASS、34グループ）
- ブラウザ確認: 起動、Google Maps 2D、通常地図／航空写真切替、スポット検索の場所専用UI、三脚配置ダイアログの高さ入力なし、コンソールエラーなし
- ソース契約確認: 下側3D候補・人物レンダラー削除、上側プレビュー専用Cesium、2D候補選択、日時／時間軸／焦点距離／カメラ高／天体／全画面の既存配線を確認

## 10. build結果

`npm run build` は TypeScript `tsc -b` と Vite production build の両方が成功しました。

## 11. 残っている問題

既知のビルドエラー・回帰エラー・ブラウザコンソールエラーはありません。外部 Google Tiles の実データに対する3D pick精度と、iPhone／Android実機のピンチ操作は、API接続状態・端末依存のため最終的な実環境確認対象です。lintには今回の変更と無関係な既存警告が残っています。

## 12. パフォーマンス上期待できる改善

- 下側3D Tilesロードと下側Cesium描画の廃止によるGPU・通信・メモリ負荷の低減
- 下側3Dカメラ更新、orbit／チルト／回転イベント、3Dエンティティ更新の廃止
- 上側Cesiumの常時レンダーループ停止によるアイドル時描画負荷の低減
- 高精度計算を省略していないため、改善対象は表示・操作・通信負荷に限定

実測値は端末・ネットワーク・Google Tilesキャッシュに依存するため、この報告では数値化していません。

## 13. 意図しない機能削除がないことの確認結果

主要UI（ハンバーガー、焦点距離、カメラ高、日時、現在時刻、時間軸、±1、天体検索、日の出・日の入、月出・月没、天の川時刻、太陽、月、天の川、北極星、透明度、プレビュー全画面、地図全画面、スポット検索、三脚候補）は既存配線を維持しました。削除範囲は下側3D専用機能と、スポット検索内の日時・構図候補UIに限定しています。
