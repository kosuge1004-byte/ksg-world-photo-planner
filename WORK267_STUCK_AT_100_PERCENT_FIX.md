# Work267 — 実機「100%で固まる／出力なし」対応

対象: WORK266のα7 V対応後、実機スタック中に進捗が100%表示のまま
固まり、出力が生成されない不具合の調査依頼への対応。

## 根本原因（コードから特定）

1. `overallProgress` は各ジョブの自己申告progressの単純平均
   (`job_scheduler.dart` `_emit()`)。最後の1枚が0.99を報告した直後に
   詰まると、表示側は四捨五入で「100%」になるが、スケジューラの
   `activeCount` は1のまま。
2. `_onSnapshot`（`processing_progress_screen.dart`）は
   `activeCount==0 && queuedCount==0`（=`isFinished`）かつ全入力が
   終端状態になるまでスタッキング／エクスポートへ進まない設計。
   つまり「100%」表示は見た目だけで、実際には最後の1ジョブの終了を
   永久に待っている状態だった。
3. `JobScheduler._run()` にはタイムアウトが無く、ネイティブRAW
   デコードが実機のメモリ／ストレージ逼迫等で詰まると、そのジョブは
   二度と終端状態にならず、UIは無期限に固まる。
4. `default_resource_reader.dart` はメモリ・発熱・電池を実機から
   読まず、常に「2GB空き・発熱なし・満充電」という固定値を返す
   スタブだった（コード内コメントで「Phase 1の暫定値」と明記）。
   実際のメモリ逼迫を検知する手段がそもそも無かった。

いずれも「低品質デモザイクへのフォールバック」とは無関係で、画質は
最初から一貫してフルセンサー・高品質パスのみ。今回の修正も画質には
一切手を入れていない。

## 修正内容

- `job_scheduler.dart`: `JobScheduler` に任意の `jobTimeout`
  (`Duration?`) を追加。`null`（既定値、既存の呼び出し元・テストは
  全てこのまま）なら挙動は完全に不変。値を渡すと、1ジョブの実行が
  その時間を超えた場合に `TimeoutException` で明示的に失敗させ、
  無期限フリーズを防ぐ。キャンセルとタイムアウトを区別し、
  タイムアウト時は失敗画面にきちんと理由が表示されるようにした。
- `processing_progress_screen.dart`:
  - フルフレームRAWジョブに `jobTimeout: perFrameProcessingTimeout`
    (6分/枚) を設定。
  - 進捗パーセント表示を、全ジョブが終端状態になるまでは99%を上限に
    クランプ。「100%だが実は動いている」という見た目の矛盾を解消。
- `default_resource_reader.dart` / `MainActivity.kt`: Android実機の
  実メモリ空き容量・電池残量を `MethodChannel`
  (`com.mobilestack.app/device_resources`) 経由で取得するよう変更。
  取得失敗時・非Android時は従来通りの安全側固定値にフォールバック
  するため、既存の同時実行数の挙動は悪化しない。

## 未実施（要ビルド環境での確認）

このサンドボックスにはFlutter/Android SDKが無く、`pub.dev`や
Google Mavenへのネットワークアクセスも無いため、以下は**未実施**:

- `flutter analyze` / `flutter test`
- Android arm64 releaseビルド
- 実機/エミュレーターでの動作確認

`test/job_scheduler_test.dart` にタイムアウト挙動のユニットテストを
2件追加済み（既定`null`で挙動不変であることの確認、および
タイムアウト発火で`failed`状態へ正しく抜けることの確認）。通常の
CI/ビルドパイプラインで上記コマンドを実行して結果を確認してください。

## 次にやると良いこと

- 実機で同じシーンを再現し、6分タイムアウトが妥当な長さか確認
  （フルサイズ・ロスレス圧縮ARWなど大きいファイルで余裕を見て
  設定しているが、低スペック端末では調整が必要な場合がある）。
- タイムアウトで失敗した場合のエラーメッセージ・再試行導線が
  ユーザーにとって分かりやすいか確認。
- 実メモリ読み取り (`MainActivity.readResourceSnapshot`) を
  `fullFrameRawConcurrencyPolicy` 以外の場面（将来複数ワーカーを
  許可する場合）でも活かすなら、低メモリ時のタイル分割/温度考慮を
  別途設計する。
