# MobileStack Work344 実装報告

2026-09-17 / 0.8.43+199 / Work337を基準に、Work338〜343の未検証下書きをレビュー・修正・統合。

ユーザーの「テストは実機でする その他お願い」に従い、実機・実RAW・単体/回帰試験は実行していません。添付文書内のテスト推奨はユーザーの依頼と区別しています。

## 統合内容

| 下書き | 今回接続した処理 | 保存・再開の単位 |
|---|---|---|
| Work338 | Focus Stack位置合わせ・focus measure・winner | 確定フレーム、選定/正則化が完了したwinner map |
| Work339 | 流星のstreak/star候補解析 | 解析が完了したフレーム |
| Work340 | CFA drizzle通常/robust経路 | 完了タイル。実際の並列robust経路にも接続 |
| Work341 | Focus Stack最終blend | RGBとcoverage maskが揃った完了タイル |
| Work342 | 天の川の最終combine | RGBとcontributionが揃った完了タイル |
| Work343 | 天の川標準moving-removal ON経路の現像 | RGB、saturation mask、RAWメタデータ/CFAが揃ったフレーム |

公開APIの追加だけで終わっていた下書きを、background workerとexport呼び出しまで接続しました。入力/dark/flat内容・設定・実装revisionに加え、最終タイルでは実際の位置合わせ結果も照合します。

## 下書きから修正した問題

- 再開時に既存ファイルを切り詰めるopen処理を修正。
- 使用中のRGB/coverageをpipeline直後に削除する処理を修正。出力の確定後にworkerが削除します。
- 全planeをflushしてからタイルSHA-256を記録し、再開前にファイル長・geometry・全確定タイルのハッシュを検証。
- 個別タイルreceiptと連鎖ハッシュを使い、巨大な全タイルJSONを毎回書き直す構造を修正。
- 中断/部分open失敗ではhandleを閉じて確定ファイルを保持。ストレージ確保前には全plane分を確認。
- CFA export後の出力receiptを追加し、最終ファイルのSHA-256検証後に完了を再利用。
- RGBのみを復元すると天の川の全フレーム色プロファイル検査が失敗する問題を修正。色メタデータ/CFAも保存・復元し、既存検査を維持。旧形式の不足キャッシュは再現像します。
- 以前の一時的なdecode失敗を固定した流星除外として再利用しないよう修正。

最高品質・元解像度・FP32とBaselineExposure 0 EVを維持しました。既存のタイル内合成演算を変更する実装は含めていません。ただし中断あり/なしの出力一致は未検証です。

## 実行した確認

- Flutter静的解析：指摘0件。
- Android arm64リリースAPKビルド：成功。DNG metadata有効。
- APK manifest：0.8.43 / versionCode 199。arm64-v8aのみ。
- native ABI：13 exportsが定義と一致。
- APK署名検証：成功。Work337と同じローカルdebug keyで署名。
- ソースZIP：CRCと収録したソース全件の内容一致を確認。ビルドcache/keystore/端末固有設定は除外。

詳細は同梱の検証結果JSON、ファイルハッシュはSHA256SUMS_WORK344.txtに記録しました。過去版の試験PASSを本版の結果として流用していません。

## 残る範囲と実機確認

winner選定/正則化の行途中、1フレームの検出途中、1タイル内の累積途中はその単位を再計算します。CFAのRAW decode/registrationと天の川のregistration解析は再実行します。focusMarkingのalignment/score途中は今回の6下書きの対象外です。

DNG圧縮strip途中の再開、全native協調cancel、double decode/二重検出削減、dual alignmentの空間正則化/判断map、全phaseのRAM admission監査は未完了です。引継ぎ全22項目の完了版ではありません。

実機では、各処理の中断なしと中断→再開の出力比較、設定/入力変更時のキャッシュ無効化、完了付近の挙動を確認してください。元の失敗条件（飛行機・人工衛星除去ON、地上の一時的な光の抑制ON、gap fill ON、両端15% fade）での天体痕・細枝・継ぎ目も未確認です。

Android実機、Adobe読込、Linux sanitizer、iOSは未検証です。Androidの6時間制限自体の変更は対象外です。

ソースZIP内のCODEX_HANDOFF_WORK344_TO_EXECUTION.mdが本版の引継ぎです。
