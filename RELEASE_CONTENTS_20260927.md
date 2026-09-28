# 最終アプリZIPの内容

最終ZIPはAstroSightのソース、生成済みJPGEO2024、ビルド済み`dist`、Android
プロジェクト、設定、マニフェスト、テスト、検査証跡を収録する。

次は別保管の原本または再生成物なのでZIPから除外する。

- `node_modules/`
- `.wrangler*` のローカル・dry-run出力
- Androidの`.gradle/`、`build/`、同期生成済みWeb assets
- `geoid/`の公式ZIP・派生gzip（原本は作業フォルダに保持）
- `dem/*.zip`の代表公式原本（Eドライブにも保持）
- `*.tsbuildinfo`、ログ

本番ジオイドは`server/data/jpgeo2024.generated.ts`に含まれるため、原本ZIPを
除外してもアプリ動作に影響しない。DEMの全国原本は
`E:\AstroSight-GSI-data-20260926\dem\official-archive`に保持する。

R2やCloudflareへのアップロード・デプロイはこの作成処理に含まれない。
