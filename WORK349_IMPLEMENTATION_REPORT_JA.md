# Work349 実装・検査報告

2026-09-18 / 0.8.44+200 / Work348を検査・修正した版。

最新のユーザー依頼に従い、自動試験、Windows実RAW確認、Androidエミュレーター検査、APK作成を行いました。以前の「テストは実機でする」という方針は今回の依頼で更新されています。添付文書の試験結果を本版のPASSとして流用していません。

## 修正内容

- Rolling経路でスコープ外のcompact変数を参照していたビルドエラーを修正。基準フレームのPSF星情報を正しいスコープに保持。
- 不使用の旧全画面noise proxyを削除し、PSF後のflat-sky noise gateを使用。
- 空/非有限/負のregistration残差、不正PSF指標、不正noise指標を成功として扱わないよう修正。
- 星周囲を除外した同じタイル内で、Reference/Finalの同じ有効2×2 blockだけを比較。Final sigma 0も測定結果として扱う。
- Referenceの測定支持が十分なのにFinalの有効測定が失われる場合はFAIL。星の少ないReferenceはunverifiedとして記録。
- 孤立した明るい点の両側に出る逆向きの切替候補が互いを前景として正当化する問題を修正。残差の向きが一致する隣接候補、または3点目の連結候補で支持を確認。2px haloでタイル分割に依存しないよう修正。
- 旧checkpoint API/pureMax起動を認識しなかった4件のsource contractを、元の動作条件を維持して更新。WORK348 revision検査は>=348を要求し、正当な更新を認識。
- Windows native buildに必要なWinsock byte-order関数のlinkを追加。Androidには適用されない条件分岐。
- Classic経路でも全フレームの採否/RMS/適用上限/p95/max/coverage/weightをログへ記録。必要採用枚数不足での拒否前にも記録。
- バージョン/引継ぎをWork349に更新。algorithmRevision 349で旧結果を無効化。

最高品質・元解像度・FP32、最終DNG BaselineExposure 0 EVを維持。Hard GateのFWHM budget 1.12とNoise Gate 1.10は緩和していません。

## 実行した検査

| 検査 | 結果 |
|---|---|
| Flutter静的解析 | 指摘0件 |
| 全Node suite | 772/772 PASS |
| 全Flutter unit/widget suite | 952/952 PASS |
| Windows native CTest | 8/8 PASS |
| Android API36 emulator native FFI統合 | 23件 PASS |
| Android emulator結果保存統合 | 2件 PASS |
| Windows 実Sony RAW | 3枚を4000×6000で新規現像・天の川合成・DNG出力 PASS |
| DNG構造/全画素readback | FP32、finite、4000×6000、BaselineExposure 0を確認 |
| Android arm64 release build | 成功 |
| APK manifest/ABI/署名 | 0.8.44、200、arm64-v8a、13 exports、署名検証 PASS |
| 完成したarm64 release APKのemulator起動 | インストール成功、MainActivity起動/継続、process crashなし |
| Source ZIP | CRCと収録ソース全件の内容一致 PASS |

追加した19件のFlutter回帰試験は、Hard Gateの境界/非有限値/PSF不足、PSF不正値、Noise Gateの同じ座標/増減/平面勾配/ゼロsigma/測定支持喪失/不正値、タイル再開/同じ長さの破損/設定変更/未確定タイル/receipt破損、dual alignmentのタイル境界を実際のDart処理で確認します。

添付版の初期検査はNode 767/771、Flutter 932/933で失敗、静的解析は5件の指摘でした。修正後の結果を上に記載しました。テストskipや品質閾値の緩和でPASSにしていません。

## 実RAW結果の範囲

入力は提供RAW一式の先頭3枚（DSC03692〜DSC03694.ARW）。Work349のnative libraryで新規現像し、採用3枚で合成しました。
PSF median FWHM ratio: 0.999582721734232 / Noise ratio: 0.870601576770314。
全出力RGBのfiniteを確認し、出力DNGを独立して読み直しました。Windows用の検査bridgeを使用したため、Android実機E2Eの証明とは区別します。

Flat-sky評価は星をanchorした候補領域とG channelの統計です。意味的なsky segmentationや全画面・全色の画質保証ではありません。1.10 thresholdの実写での再校正、天の川微細構造/前景/細枝の視覚A/Bは残っています。

## 未実行・残課題

実Android端末でのRAW E2E、OS kill/6時間制限からの再開、376枚全合成、他カメラの実機corpus、Adobe読込、iOS、Linux sanitizerは未実行です。今回のAndroid検査はエミュレーターで、実機とは区別します。
過去の引継ぎ全22項目は完了していません。DNG strip途中再開、全native協調cancel、全phase RAM監査などの旧残課題を今回解消済みとは扱いません。

APKは以前のWork337/344と同じローカルdebug keyで署名した実機確認用release buildです。
ソースの現行引継ぎはCODEX_HANDOFF_WORK349_TO_EXECUTION.md。検査ログとhost harnessはWORK349_VALIDATION_EVIDENCE内に同梱します。
