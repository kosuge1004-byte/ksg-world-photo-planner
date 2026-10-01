# Work361: 天の川の合成（κ-σ）をタイル並列化（出力はビット一致）

## 背景
Work350 実機ログで合成は 4.6秒/タイル×1504タイル ≒ 1.9時間（全体の約7割）。1コアで順番に処理していた。
各出力画素は、そのタイルの入力（各フレームの読み出し・位置合わせ・κ-σ）だけで決まり、タイル間に依存がない。

## 変更
| ファイル | 内容 |
|---|---|
| lib/core/session/milky_way_pipeline.dart | タイル1枚の計算を `_combineClassicTile` に切り出し、逐次経路と並列経路で同じ関数を使用。並列経路はワーカー Isolate がフレームを読み取り専用で開き直してタイルを計算し、結果（RGB・寄与数）を転送。本体はタイル順にだけ書き込み、途中保存の進捗・ログ・24ms の休止は従来どおり |
| 同上 | `combineWorkerIsolates`（既定1＝従来の逐次）。並列は全フレームが確定済みのファイル保存で、利用可能メモリの1/4に収まる場合のみ（ワーカーごとに飽和マスクの複製と約64MB）。収まらなければ逐次 |
| lib/core/session/export_pipeline_result.dart / lib/core/background/standard_stack_background_worker.dart | バックグラウンドの天の川はコア数に応じて 8コア以上:3、6コア以上:2、それ未満:1 |
| test/milky_way_parallel_combine_equivalence_test.dart | 4フレーム・64pxタイルで、逐次（1）と並列（3）の出力をバイト単位で比較 |
| tool/work361_parallel_combine_contract.test.mjs | 静的契約4件 |

## 見込み（未計測）
3ワーカーで合成段は約1/2〜1/3（1.9時間 → 40分〜1時間）。端末の発熱による速度低下がある場合は効果が小さくなる。

## 注意
- ワーカー内では前景二重位置合わせ中の「失敗工程」表示の切り替えを行わない（失敗時は「kappa-sigmaロバスト合成」として記録される）。計算結果には影響しない。
- 発熱が問題になる場合は classicCombineWorkerCount の値を下げる（出力は変わらない）。

## 検査
実施: Node 全テスト 863/863 PASS。未実施: flutter test（上記の等価性テストを含む）、実機の時間・温度・メモリ。
