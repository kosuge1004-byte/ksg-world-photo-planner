# R2無料枠カウンター（D1）の設定

AstroSightはR2を共有DEM・APIキャッシュとして維持する。Cloudflareの無料枠を
超えないよう、全R2経路で同じD1データベース
`astrosight-r2-write-budget`を予算カウンターとして使う。

## 強制する上限

- 新規保存予約量: 全期間4,000,000,000 bytes
- R2書き込み: 100,000回/月
- R2読み取り: 1,000,000回/月
- 1オブジェクト: 512 KiB
- 1リクエスト: 書き込み64回、読み取り256回

D1未設定・集計エラー・上限到達時はR2アクセスだけをバイパスする。検索や
標高計算は通常の取得経路へ戻るため、結果の精度は変わらない。

## 構成済みバインディング

次の4設定は同じD1 IDを参照する。

- `wrangler.jsonc`
- `wrangler.spot-search.jsonc`
- `wrangler.bearing-profile-download.jsonc`
- `wrangler.prewarm.jsonc`

binding名はすべて`R2_WRITE_BUDGET_DB`とする。1経路でも別DBや未設定にすると、
その経路は安全のためR2をバイパスする。

## 初回テーブル作成

データベース作成後に一度だけ実行する。

```sh
npx wrangler d1 execute astrosight-r2-write-budget --remote --file=./migrations/0001_create_r2_write_budget.sql
```

既存の`r2_write_budget`テーブルをそのまま使い、次のキーを保持する。

- `read:YYYY-MM`: 月間読み取り予約数
- `write:YYYY-MM`: 月間書き込み予約数
- `storage-reserved-bytes:v1`: この安全装置導入後の累積保存予約量

カウンターは実使用量より少なくならないように予約制で加算し、失敗した書き込みや
使わなかった読み取り予約も戻さない。無料枠保護側にだけ誤差が出る。

## 確認

D1 Consoleで次を実行する。

```sql
SELECT month, writes FROM r2_write_budget ORDER BY month;
```

R2の既存オブジェクトは`storage-reserved-bytes:v1`に含まれないため、デプロイ前後に
Cloudflare DashboardのR2保存量も確認する。全国DEMや85GBのデータをR2へ
一括アップロードしてはいけない。
