# EドライブDEMをAstroSightから安全に使う手順

## このPCの構成（独自ドメインなし・無料）

登録済み201スポットはCloudflare R2にある計算済み地形断面を最優先で使う。完全一致しない新規座標だけが、Cloudflare Quick Tunnelを通してこのPCのEドライブを最後の正確な計算経路として使う。

```text
スマートフォン
  -> AstroSight Pages / Workers
  -> 15分で失効するQuick Tunnel URLをKVから取得
  -> X-AstroSight-Origin-Tokenで認証
  -> 127.0.0.1:8789 の読み取り専用API
  -> E:\AstroSight-GSI-data-20260926\dem\r2-ready
```

独自ドメインをCloudflareへ登録する必要はない。Quick Tunnelの公開URLはPCまたはcloudflaredの再起動ごとに変わるため、PCからPagesの固定登録APIへ5分間隔で通知する。KVレコードは15分で自動失効し、停止した古いURLは使われ続けない。1日あたり約288回の同一キー更新で、設定した間隔ではKV無料枠内に収まる。

Quick TunnelはCloudflareが試験・開発用途として提供する接続で、稼働保証はない。そのためR2上の登録済みスポットを主経路のまま維持し、新規座標の最後の砦だけに使う。PC、Eドライブ、Tunnelのいずれかが停止している場合は短時間でエラーを返し、旧約54分経路へ移らない。

## データ配置と精度

- 国土地理院のZIP原本: `E:\AstroSight-GSI-data-20260926\dem\official-archive`
- 前処理済みDEM: `E:\AstroSight-GSI-data-20260926\dem\r2-ready\gsi-local-dem-v1`
- 登録スポット計算済み断面: `E:\AstroSight-GSI-data-20260926\dem\r2-ready\precomputed-bearing-profile-v1`

原本と前処理済みDEMはアプリZIPやGitHub、R2へ含めない。正確な新規座標では、登録スポットの結果を平行移動して流用せず、同じ公式GMLまたは共有済み国土地理院PNGタイルを使ってその緯度・経度を再計算する。DEM優先順位、Constrained Bicubic/Bilinear補間、JPGEO2024地点別補正、NoData判定は従来と同じである。

## 1. データ変換と登録スポットの事前計算

```powershell
powershell -ExecutionPolicy Bypass -File tools/local-dem-server/prepare-data.ps1
npm.cmd run local-dem:precompute-landmarks
```

両処理は完了済みファイルを検査して再利用する。公式ZIPは展開元として読むだけで変更しない。計算済み地形断面は日時・焦点距離・構図に依存しないため、同じスポットの太陽・月・天の川検索に再利用できる。

## 2. Cloudflareデプロイ前の確認

この手順と `functions/api/local-dem-register.ts` を含むアプリをGitHub経由でデプロイする。Pagesには既存の `SPOT_SEARCH_JOBS` KV、各Workerには同じKVのbindingが必要である。`NETWORK_CACHE` R2と無料枠ガードは削除・停止しない。

Pagesのsecretは設定後に作られた本番デプロイへ反映させる。手順4でsecretを設定してから本番デプロイを作成する。先にデプロイ済みだった場合は、同じソースをもう一度デプロイまたは再試行する。

Cloudflare Workersの外向き `fetch()` は `redirect: "error"` を受け付けない。Eドライブ登録・計算経路では `redirect: "manual"` を使い、3xxを非成功レスポンスとして拒否する。これにより認証ヘッダーを転送先へ送らず、Workers上でも通信開始前の例外を起こさない。

## 3. cloudflaredのインストール

管理者権限を要求しないユーザー専用配置を使う。

```powershell
npm.cmd run local-dem:install-cloudflared
```

公式Cloudflare GitHub Releaseから固定バージョンを取得し、公式掲載のSHA-256と完全一致した実行ファイルだけを `E:\AstroSight-GSI-data-20260926\runtime` に置く。システム全体のPATHやWindowsサービスは変更しない。

有料プラン、ドメイン購入、ルーターのポート開放は不要である。LAN向けの `0.0.0.0`、SMB共有、RDPも使わない。

## 4. 2つのsecretを作成・設定

```powershell
npm.cmd run local-dem:configure-domainless
```

| secret | 配置 | 用途 |
|---|---|---|
| `LOCAL_DEM_ORIGIN_TOKEN` | Pages、3 Worker、PC | EドライブAPIへの要求を認証 |
| `LOCAL_DEM_REGISTRATION_TOKEN` | Pages、PCのみ | 変動するQuick Tunnel URLの登録を認証 |

PC側の値は `E:\AstroSight-GSI-data-20260926\runtime\local-dem-secrets.json` にWindows DPAPIで暗号化し、現在のWindowsユーザーとSYSTEMだけが読めるACLで保存する。値を画面、ログ、リポジトリ、配布ZIPへ出力しない。Pages登録APIはCORSを許可せず、正しい登録トークンと `https://<1ラベル>.trycloudflare.com/` だけを受理する。さらにPagesからPCの認証付き `/v1/health` へ往復でき、オリジントークンも一致した場合だけ、サーバー側で固定した `/v1/elevation/batch` をKVへ登録する。

このコマンドの完了後に、GitHub経由でPagesの本番デプロイを作成または再試行する。

暗号化ファイルを作成したWindowsユーザーと自動起動ユーザーが異なる場合など、DPAPIを復号できないときは、同じWindowsユーザーで次を実行して2値を安全にローテーションする。新しい値をCloudflareへ設定する処理まで含むため、その後にPagesをもう一度本番デプロイする。

```powershell
npm.cmd run local-dem:configure-domainless -- -ResetSecrets
```

## 5. 起動確認と自動起動

```powershell
npm.cmd run local-dem:start-domainless
```

別のPowerShellから `Invoke-RestMethod http://127.0.0.1:8789/health` を実行すると、応答は `{"ok":true}` だけになる。Eドライブのパス、ファイル名、データ一覧は返さない。

```powershell
npm.cmd run local-dem:install-autostart
```

インストールコマンド自身がタスクを直ちに起動し、ローカルヘルスとPagesからの往復登録が成功するまで検査する。90秒以内に両方を確認できなければ成功扱いにせず終了する。タスクは現在のWindowsユーザー権限で非表示起動し、管理者権限では実行しない。稼働ログはトークンやローカルパスを含めず `%LOCALAPPDATA%\AstroSight\local-dem-gateway.log` に残す。PCがスリープ中、ログオフ中、電源OFF、Eドライブ切断中は新規座標のEドライブ計算を利用できない。

登録済みスポットはPC停止中もR2から取得できる。新規座標で `LOCAL_DEM_PROFILE_UNAVAILABLE` が返る場合は、まずこのタスクが `Running` であることと、ログの最新部分に `Quick Tunnel heartbeat registered` があることを確認する。前面のPowerShellやCodexの実行セッションだけで起動したプロセスは、その画面やセッションが終了すると停止するため常用しない。

## 公開される範囲

- `POST /v1/elevation/batch`
- `POST /v1/bearing-profile/precomputed`
- `POST /v1/bearing-profile/compute`
- 内容を持たない `GET /health`
- オリジントークンを要求する内容を持たない `GET /v1/health`

ファイルパス、フォルダー一覧、任意ファイルの読取り・書込み・削除APIはない。ローカルAPIは本文容量、地点数、日本域、同時実行数、計算時間を検査し、オリジントークンを定時間比較する。不足する公開GSI PNGだけは固定形式の派生キャッシュとしてEドライブへ原子的に保存できるが、外部要求から保存先やキーは指定できない。

## 独自ドメインを後から用意する場合

固定ホスト名のNamed TunnelとCloudflare Access Service Tokenへ切替できる。その場合は `LOCAL_DEM_API_URL`、`LOCAL_DEM_ORIGIN_TOKEN`、`LOCAL_DEM_ACCESS_CLIENT_ID`、`LOCAL_DEM_ACCESS_CLIENT_SECRET` の4 secretをPagesと3 Workerへ設定する。Accessの2値は必ず対で設定する。この固定経路がある場合はKVのQuick Tunnel URLより優先される。

## 検査

```powershell
node --import ./scripts/register-typescript-source-loader.mjs --test tests/regression/local-dem-gateway.test.mjs tests/regression/local-dem-registration.test.mjs tools/local-dem-server/local-dem-server.test.mjs
node scripts/verify-local-dem-origin.mjs
node scripts/verify-workers-kv-writes.mjs
npx.cmd tsc -b --pretty false
```

本番接続後は、登録済みスポットがR2から即時取得できること、新規座標がEドライブで完全計算されること、PC停止後は短時間で明示エラーになることを確認する。海面・NoDataを推測値へ置換せず、1点でも不完全な全方位データを完成扱いにしない。
