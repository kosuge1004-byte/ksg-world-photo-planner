# Work353: 深度合成 写真間の明るさ・色の自動整合（既定OFF）

## 目的
マクロの実効F値変化・照明のちらつき・写真ごとのWBで写真間に明るさ/色差があると、画素単位で
写真を切り替える深度合成の境界にまだら・段差が出る。

## 方法
基準写真の出力格子上 48×32 ブロック（32px）の平均RGBと、各写真を位置合わせ変換で対応させた同位置の
ブロック平均の比の中央値をチャンネル別ゲインとする（ボケは大ブロックの平均をほぼ保存）。
両者とも全チャンネルが [0.01, 0.8] のブロックのみ使用。有効30未満、またはゲインが [0.5, 2] 外なら補正しない。
ゲインはタイル合成時に各写真のリサンプル結果へ乗算（基準は1）。

## 変更
| ファイル | 内容 |
|---|---|
| lib/core/focus_stack/focus_photometric_normalization.dart | 新規（推定・ブロック中心・適用） |
| lib/core/focus_stack/focus_tiled_blender.dart | frameGains 引数（null で従来と同一）、使用時のみチェックポイントに束縛 |
| lib/core/focus_stack/focus_stack_pipeline.dart | normalizeFrameExposure（既定false）、推定結果をログ |
| lib/core/background/focus_stack_background_worker.dart | payload `focusNormalizeExposure`（無ければ false） |
| lib/core/background/background_stack_controller.dart | 起動時に設定を読み payload へ（読込失敗は既定値） |
| lib/core/settings/app_settings.dart / lib/features/focus_stack/focus_stack_settings_screen.dart | 設定「写真間の明るさ・色を自動で揃える」 |
| tool/raw_samples/focus_photometric_gain_reference.mjs ほか | Node 参照・テスト6件、契約3件 |
| test/focus_photometric_normalization_test.dart | Dart テスト |

## 既知の限界
合焦度（修正ラプラシアン）の計算は補正前の輝度で行う。数%の明るさ差による勝者選択への影響は小さいが、
合焦度側の正規化は未対応。

## 検査
実施: Node 全テスト PASS（参照テストで、ぼかし＋チャンネル別ゲインの合成データからゲインを0.5%以内で推定）。
未実施: flutter analyze / flutter test、実機・実RAW比較。
