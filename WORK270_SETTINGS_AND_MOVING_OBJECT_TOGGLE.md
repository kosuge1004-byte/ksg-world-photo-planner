# Work270 — 天の川スタック設定画面 / 移動体自動削除ON/OFF

## 変更内容
- RAW画像選択画面から「画質」「出力方式」「ファイル容量」を分離。
- 通常フローを RAW画像選択 → 基本画像選択 → 各種設定 → 処理開始 に変更。
- 各種設定画面に以下を配置。
  - 画質
  - 出力方式
  - ファイル容量（旧「Lightroom保存」）
  - 天の川通常モードのみ「移動体（飛行機等）自動削除」ON/OFF
- 移動体自動削除の既定値はON（従来挙動維持）。設定はSharedPreferencesへ保存。

## 処理の意味
- ON: 従来どおりKappa-Sigma外れ値除去を実行。
- OFF: 位置合わせ、静止前景保持、フレーム品質重み付け等は維持し、外れ値棄却のみ停止。全covered sampleを重み付き平均する。
- これにより、流れ星など単発の光跡を「外れ値」として自動削除したくない場合にOFFを選べる。

## 配線
StackSettingsScreen
→ ProcessingSession.automaticMovingObjectRemoval
→ ProcessingProgressScreen
→ registerAndCombineDecodedFramesAndExport
→ registerAndCombineDecodedFrames
→ TiledKappaSigmaCombiner.enableOutlierRejection

## 追加テスト
- ProcessingSession: 既定ON / OFF切替
- StackSettingsScreen: 移動体自動削除スイッチ表示・切替
- TiledKappaSigmaCombiner: OFF時に [1,1,1,1,10] の単発外れ値を棄却せず平均値2.8、寄与数5として保持

## 検証制限
この実行環境にはFlutter/Dart SDKが無いため flutter test / flutter analyze / APKビルドは未実行。
ソース配線の静的検査はPASS。実機・Flutter環境でのコンパイルおよびテスト実行が必要。
