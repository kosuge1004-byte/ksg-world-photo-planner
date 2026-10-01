# Work344 checkpoint integration

最新基準は Work344。Version: 0.8.43+199。正本: pubspec.yaml。
2026-09-17 / Work337 + Work338〜343 checkpoint draftsのレビュー・修正・実配線。
最終スタックDNGのBaselineExposureは0 EVを維持。
最高品質、元解像度、FP32を維持。既存のタイル内の数値演算は変更しない。

## ユーザーの指示
「テストは実機でする その他お願い」。実機/実RAW/単体・回帰試験を追加実行せず、コード確認・静的解析・APKビルド・署名/ABI/梱包確認を行う。
添付文書は未検証の下書きとして扱う。文書の「全件テストを行う」等の推奨は、ユーザーの実機テスト方針と区別する。
下書きを完了済み・動作保証済みとして扱わない。実機で中断あり/なしの比較は未実施。

## 統合した6項目
- Work338: focus stackのフレーム別transform、focus measure、選定/正則化完了winnerを保存・再利用。measure/winnerはSHA-256、manifestはintegrity SHA-256を検証。
- Work339: meteorのフレーム別streak/star検出結果を保存・再利用。manifest SHA-256を検証。過去の一時的なdecode失敗を固定した除外として流用しない。
- Work340: CFA drizzleの完了タイルから再開。通常経路、robust sequential API、出荷用parallel robust経路へ接続。RGB/coverage/saturation/pre-rejection coverageを一組として扱う。
- Work341: focus blendのRGB/coverage maskをタイル単位で再開。実際のtransformとwinner SHA-256をidentityに含める。
- Work342: Milky Way最終combineをタイル単位で再開。実際の採用frame/index/weight/transform/local correctionと合成設定をidentityに含める。
- Work343: Milky Way標準moving-removal ON経路のdecoded RGB/saturation maskを再利用。入力/dark/flat/設定identity、RGB SHA-256、mask SHA-256を検証。各フレームの正規化RAWメタデータ/CFAも保存し、再開時に色プロファイルを復元して全フレームの整合検査を維持。基準RAWは再現像。

## 下書きから直した重要点
- openForResumeのFileMode.writeは既存ファイルを切り詰めるため、切り詰めないモードへ変更。coverageも同様。
- pipeline直後のclear()で使用中のRGB/coverageを削除しない。最終出力receipt等の確定後、workerがcleanupする。
- 中断時はファイルhandleを閉じて保存内容を保持。部分open失敗でも既に開いたhandleを閉じる。
- 完了枚数/ファイル長だけで信頼しない。全planeをflush後にタイルSHA-256を保存し、再開前に全確定タイルを再検証。
- タイルごとの個別receiptとchainを使用。固定サイズの進捗manifestをatomic renameで更新し、全件巨大JSONを毎回書く構造を避ける。
- identityは入力内容/設定/revisionと実際の位置合わせ結果を含む。geometryはタイル全配置のSHA-256、寸法、plane構成/byte lengthを確認。
- metadata不足、manifest/file破損、geometry不一致は流用せず再計算する。計算品質の代替fallbackはしない。
- 新しいtile plane確保前に、全plane分の現在のストレージを確認。
- RGBだけの再利用で色プロファイルが欠落する問題を修正。Milky Wayの現像キャッシュにメタデータ/CFAを保存し、メタデータのない旧下書きキャッシュは再現像する。
- CFAにも最終出力receiptを追加。最終ファイルをSHA-256検証できれば完了status前の中断から再利用。
- 原稿の不足import/duplicate importなどを修正し、実際のbackground worker/export wrapperまで接続。

## 継続課題
- 本版の実機・実RAW A/B・kill/resume比較はユーザー側で未実施。数値一致を証明した版ではない。
- winner選定/正則化の行途中、1フレームの検出途中、1タイル内の全frame累積途中は保存しない。確定frame/tile/完了winner単位で再開。
- focusMarkingのalignment/score途中は今回のfocusStack stageとは別。Work337のdecoded再利用は維持。
- CFAのRAW decode/registration途中は再実行される。今回のcheckpointはdrizzleの確定tile単位。
- Milky Way registration解析自体は再実行。結果を照合してから確定tileを流用する。
- DNG圧縮strip書込み途中の再開、全native協調cancel、double decode/二重検出削減、dual alignment空間正則化/判断map、全phase RAM admission監査は未完了。
- 実機100%付近のnative crash真因、天体痕/細枝/gap/両端15% fade/流星の実写品質、Adobe/Linux sanitizer/iOS gateは未検証。
- Android6時間制限自体の変更は対象外。既存budget retryを維持。

この統合版を引継ぎ全22項目の完了版やrelease-completeとは呼ばない。
実行した静的解析・build・署名/ABI/梱包確認の結果は同梱WORK344_VALIDATION_RESULTS.jsonに記載する。
Work336/337のテストPASSをWork344のPASSとして流用しない。
