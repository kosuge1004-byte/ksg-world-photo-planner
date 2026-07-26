# スポット検索のバックグラウンド起動

- `/api/spot-search-start`は同期Functionとしてジョブを先に保存する。
- 長時間計算は`/api/internal/spot-search-worker`のBackground Functionへ分離する。
- 検索中に画面を非表示にしてもサーバー側計算を継続する。
- クライアントは`/api/spot-search-status`から保存済み状態を確認する。
- Background Functionの実行結果はNetlify Blobsへ保存し、元のHTTP応答本文には依存しない。
