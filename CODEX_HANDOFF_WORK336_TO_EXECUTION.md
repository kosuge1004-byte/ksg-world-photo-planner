# Work336 implementation and remaining work

最新基準は Work336。Version: 0.8.41+197。正本: pubspec.yaml。
Date: 2026-09-16。Work335からの修正作業版であり、全22項目の完了版ではない。
最終スタックDNGのBaselineExposureは0 EVを維持。
FP32、最高画質、元の解像度を維持する。

## Implemented
- Androidの全status writerを共通のロック・revision CAS・fsync・atomic renameへ集約。
- 古いheartbeatによるpause/完了の上書きを拒否。確定項目数を減らさない。
- 旧processorの終了未確認で再起動待機期限に達した場合は、再起動せず安全に停止。
- 地上光抑制を明示した地上ポリゴン内に限定。内側featherとhalo付き連続窓を使用。
  設定ON時は基準RAWの地上領域指定が必須。
- 星の軌跡の隣接候補を全検索し、恒星運動に一致する候補を優先して対応付け。
- gap fillは推定済み恒星対応のみを利用し、失敗時は接続を省略して診断を記録。
  接続色はfade適用後の両端RGBから補間。合成画素maskを受け取るAPIを追加。
- 出荷用の流星タイル合成で、背景・前景・候補端点を同じ恒星基準座標に位置合わせ。
  選択前景を背景に含める入力を拒否。位置合わせ失敗時は明示的に停止。
- focus alignmentでMAD=0でも有限ゲートで外れ値を除去。
- UIからの再開容量検査を6jobKindへ拡張。既存入力の二重stagingを計上しない。
- 流星解析の確定済みdecoded frameを入力/SHA-256・RGB/SHA-256で検証して再利用。
  レビューJSONもpendingからatomic renameして保存。処理journalを追加。
- バージョン・開始文書・現行引継ぎ・release gatesを現在の基準へ同期。

## Outstanding / unverified
- P0-02: 100%付近の実際の端末クラッシュ再現とlogcat/tombstone診断。
- P0-03: focus/focusMarking/CFA drizzle、流星の解析途中、export途中の全phase checkpoint。
- P0-04: Milky Way moving removal ONのdecode再開と実機RAM/storage計測。
- P0-05: 純粋max参照出力の独立したdebug成果物・実RAW readback。
- P0-06/P0-07/P1-08: 実RAWでの天体痕保護・細枝境界・gap品質の検証。
- P1-09: fadeの仕様検証（ユーザー設定は両端15%）。
- P0-10: 実RAW検証（旧non-tiled helperも位置合わせを統一済み）。
- P1-12: Milky Wayのdual alignmentの空間正則化と判断map。
- P1-14: native自動再開時の全phase容量検査。
- P1-15: transient障害の分類/backoffとretry capの拡張。
- P1-16/P2-17: 全native callのjournal/協調キャンセル。
- P1-18/P1-19/P1-20: double decode・二重検出の削減、端末profiling。
- P1-22: 実機・Adobe・Linux sanitizer・iOSのmandatory gate。
- 合成前のRAW一式と端末接続がないため、添付DNGの実写A/B試験は未実施。
  添付DNGは6000x4000 FP32 LinearRAW、全画素有限。欠損はDNG本体にも存在する。
  再現・修正確認には元のRAWから再合成が必要。

## Regression checks
Node: tool以下の*.test.mjs全件。Flutter: pub get / analyze / test。
Android: debug/release buildおよびnative ABI export検査。
実行結果は同梱の実装報告に記録。未実行を合格扱いしない。
