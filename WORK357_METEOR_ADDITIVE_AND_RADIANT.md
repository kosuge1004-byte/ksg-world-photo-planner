# Work357: 流星 足し込み合成・放射点の整合表示（足し込みは既定OFF）

## ソース確認で判明したこと
- 合成は登録済みの流星フレームと背景を、光跡の周囲（幅/2＋3px）で画素ごと・チャンネルごとの最大値で合成する。
  マスク内の空は max(背景, 1枚分のノイズ) になり、流星に沿って明るくざらついた帯が出る。
- 本番の合成（compositeSelectedMeteorStreaksTiledAndExport）は、流星を含むフレームを背景スタックに入れない
  （入れるとエラー）。検査3/4の「背景に流星の残りかす」はこの経路では起きない。

## 足し込み合成（meteorCompositeBlendMode = additive）
out = 背景 + f(d)·shrink(前景 − 背景 − offset)
- offset・σ: マスク外側6pxのリングでの (前景 − 背景) の中央値・MAD（チャンネル別）。1枚と平均の空の明るさの差を補正。
- shrink(e) = e·smoothstep((e − σ)/(2σ)): ノイズ程度の差は0、流星（e ≫ σ）はそのまま。
- f(d): 芯（幅/2＋1px）で1、マスク端で0へ滑らかに減衰（硬い縁なし）。
- パラメータは光跡ごとに全体座標で1回だけ推定（出力タイルに依存しない）。
Node 参照: 帯の明るさの偏り 最大値方式 +0.003 超 → 足し込み ±0.0015 以内、芯は 前景−空差 に一致、タイル分割で完全一致。

## 放射点との整合（表示のみ）
直線投影では流星の経路は放射点を通る直線になる。候補の光跡直線の交点を総当たりで調べ、3本以上が
±3°以内で向く点を放射点とし、各候補に「放射点と整合」を表示する（並び順・選択は変えない。候補3〜200件で計算）。

## 変更
| ファイル | 内容 |
|---|---|
| lib/core/meteor/streak_compositor.dart | 合成方式の列挙、足し込みパラメータ推定、足し込み合成、放射点推定 |
| lib/core/meteor/meteor_composite_result.dart | 本番タイル合成に blendMode（既定 lighten）、足し込み時は出力ループ前にパラメータ推定 |
| lib/core/background/meteor_composite_background_worker.dart / background_stack_controller.dart | payload `meteorCompositeBlendMode`（無ければ lighten、設定読込失敗も lighten） |
| lib/core/settings/app_settings.dart / lib/features/meteor/meteor_review_screen.dart | 候補選択画面に「流れ星を背景になじませて合成」、候補カードに「放射点と整合」 |
| tool/… / test/… | Node 参照・テスト3件、契約4件、Dart テスト |

## 限界
- 足し込みは Android のバックグラウンド合成（本番経路）のみ。画面内プレビュー合成は従来の最大値。
- 光跡がマスク内の星と交差する場合、その星は1枚分の値になる（登録誤差があれば星がわずかにずれる）。
- 超広角の歪曲が大きいと直線性が崩れ、放射点の整合判定が甘く/厳しくなりうる（表示のみで処理に影響しない）。

## 検査
実施: Node 全テスト 849/849 PASS。未実施: flutter analyze / flutter test、実機・実RAW。
