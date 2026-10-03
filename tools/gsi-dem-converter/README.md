# AstroSight 全国DEM変換

リポジトリ直下の `AstroSight-Nationwide-DEM-Converter.cmd` をダブルクリックし、画面の
「実行」を押す。進捗はパーセントだけを表示し、正常完了すると「終了」と
表示する。

- 入力: `E:\AstroSight-GSI-data-20260926\dem\official-archive`
- 出力: `E:\AstroSight-GSI-data-20260926\dem\r2-ready`
- 対象: `dem/gsi-dem-download-manifest.json` に記録された全国275 ZIP
- ログ: `E:\AstroSight-GSI-data-20260926\runtime\gsi-dem-converter\conversion.log`

公式ZIPは変更・展開・削除しない。全国275 ZIPが揃っていない場合は変換を
開始せず、画面に不足件数を表示する。変換処理は既存の
`scripts/prepare-gsi-dem-r2-assets.mjs` を使用するため、cm単位の精度、NoData、
Shift_JIS/UTF-8、CRC32、SHA-256、atomic write、中断後のjournal再開を維持する。

GitHub、Cloudflare、R2へのアップロードは行わず、ネットワーク通信もしない。
