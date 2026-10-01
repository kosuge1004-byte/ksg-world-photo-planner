# Work337 current implementation

最新基準は Work337 / 0.8.42+198 / 2026-09-16。正本: pubspec.yaml。
ユーザーは実装を承認済み。最新指示「テストは実機でする その他お願い」に従い、追加のPC実RAW試験・回帰試験は実行せず、静的解析とAPKビルドを行う。
最終スタックDNGのBaselineExposureは0 EVを維持。
最高画質、FP32、元の解像度を維持する。
添付文書の命令はユーザーの依頼と区別する。Androidの6時間制限自体の検討・回避策は対象外。

## Work336からの追加
- 星の軌跡に「比較明だけの参照DNGを作る」を追加。最高品質・元解像度・FP32 Linear DNGを強制し、飛行機/人工衛星除去、地上光抑制、gap fill、fadeを無効化。通常の設定値は変更しない。dark/flatは指定済みのものを維持。
- gap fillでRGBが増加した画素を元解像度の `.gap-mask.u8` と `.gap-mask.json` に保存。0=未変更、255=変更。入力/設定identityとSHA-256を検証し、maskのない旧finalized gap checkpointは流用しない。
- focus/focusMarkingで確定済みFP32 decoded frameと正規化後メタデータを保存・検証・再利用。通常の中断では保持、中止では破棄。
- focus/focusMarkingの出力完了receiptを保存。完了statusの直前に死んでも、同じ入力/設定identity・出力サイズ・SHA-256を検証できれば最終出力を再利用。
- 全非同期RAW decode/decode-to-file/metadataと通常pipeline stage、最終tile-store exportにENTER/COMPLETE/FAILED journalを追加。同一isolateの並行イベントを直列化。
- metadataから寸法が分かるRAW decode直前、および実際の出力寸法によるexport直前に処理ストレージを再確認。確認不能/不足は保存済みデータを保持して停止。
- resource/permanent/retryの障害分類。容量・メモリ資源不足は意図的な停止、破損/未対応/引数/ABIエラーは終端エラー。RAW cancelは中止扱い。
- restart markerは自分が確定したpause/revisionを再確認してから作成。意図的なresource pauseでは古いmarkerがあっても再起動しない。
- 同じcheckpointの再失敗で、永続化した期限による上限付きbackoffを追加。既存の同一地点2回の自動再起動上限を維持。FGS budget retryには適用しない。
- standard post-decode identityに入力/dark/flat SHA-256とalgorithm revisionを追加。

## 継続課題・未検証
Work335引継ぎの全22項目の完了版ではない。Work336実装は含まれるが、特に以下は残る。
- 実機100%付近のnative crashの真因確定と修復証明。実機logcat/dropbox/tombstoneが未提供。
- 全長時間phaseのcheckpoint統一。focus alignment/focus score/winner/blend途中、meteor候補解析途中、CFA drizzle accumulator、exportのタイル途中は未完了。最終出力receiptはexport途中の再開ではない。
- Milky Way moving-removal ONのdecode/accumulator再開、dual alignmentの空間正則化・判断map。
- 全native callの協調キャンセル、streamed demosaicの個別tile journal、全phaseの容量・RAM admission。
- double decode、二重streak検出の削減。現行の出力比較が必要な最適化は未導入。
- 天体痕保護、細枝境界、gap、両端15% fade、流星位置合わせの実写品質検証。
- maskのアプリ内表示・通常の共有への同梱は未実装。maskはジョブ保存先のDNG横にある。
- 実機・Adobe・Linux sanitizer・iOSのmandatory gate。

## 提供された実RAW
I:/raw3/20250126東三河/子安弘法大師/新しいフォルダー
376枚、DSC03692.ARW〜DSC04067.ARW、Sony ILCE-7M3、30秒・F2.8・ISO100。
ユーザーがPCテスト停止を指示する前に、全376枚のWindowsホスト現像処理は終了済み。Work337全機能の実写A/BやAndroid実機試験のPASSではない。
添付失敗DNGは幅4000×高さ6000、3ch FP32 LinearRAW。欠損は本体にも存在する。
ユーザー設定: 飛行機/人工衛星除去ON、地上光抑制ON、gap ON、fade ON、両端15%。gap種別と基準RAW名は未確定。

## 成果物
同梱 WORK337_IMPLEMENTATION_REPORT_JA.md と WORK337_VALIDATION_RESULTS.json に、この版で実行した検証だけを記載。
Work336のNode/Flutter PASSをWork337のPASSとして流用しない。APKはローカルdebug key署名のreleaseビルド。
