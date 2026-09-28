# EドライブDEMをAstroSightから安全に使う手順

## 構成

国土地理院から取得済みのZIPは `E:\AstroSight-GSI-data-20260926\dem\official-archive` に原本のまま保存する。前処理済みデータは `E:\AstroSight-GSI-data-20260926\dem\r2-ready` に作る。アプリはドライブやWindows共有を直接公開しない。

```text
Pages / Workers
  -> HTTPS + Cloudflare Access service token
  -> Cloudflare Tunnel
  -> 127.0.0.1:8789 の読み取り専用API
  -> E:\...\dem\r2-ready\gsi-local-dem-v1\...
  -> E:\...\dem\r2-ready\precomputed-bearing-profile-v1\...
```

ローカルAPIは、準備済みEドライブデータと不足部分の国土地理院公開DEMを使い、`DEM1A -> DEM5A -> DEM5B -> DEM5C -> DEM10B` の最終判定まで完了してからCloudflareへ返す。これにより、Workerが地点ごとの公開タイル取得を繰り返して無料プランの外部サブリクエスト上限へ達することを防ぐ。APIが応答しない、認証に失敗する、または応答検査に失敗した場合だけ、Cloudflare側の従来経路へ戻る。

登録済みスポットは、富士山と山以外の全スポット（城・建物・塔・寺社・テーマパーク・観覧車）の360方位を10kmまで事前計算できる。計算結果には各距離点の1m優先DEM、JPGEO2024の地点別ジオイド補正、NoData判定を含む。日時・焦点距離・構図に依存しない地形断面なので、同じスポットの太陽・月・天の川の全検索で再利用する。

この構成は85 GB級の原本をCloudflareへアップロードしない。既存R2は停止せず、`server/r2SafetyBudget.ts` の無料枠ガードを維持する。TunnelやAccessで有料プランを選ぶ処理は含まれない。Cloudflare側で料金または支払い方法を要求する画面が出た場合は契約せず、無料プランの範囲を確認してから進める。

## 1. 変換

PowerShellでリポジトリのルートから実行する。

```powershell
powershell -ExecutionPolicy Bypass -File tools/local-dem-server/prepare-data.ps1
```

ZIP原本は展開・変更されない。中断後に同じコマンドを実行すると、journalとSHA-256を検査して完了済みアセットを再利用する。完了条件は次のファイルが存在し、変換コマンドが終了コード0を返すことである。

```text
E:\AstroSight-GSI-data-20260926\dem\r2-ready\gsi-local-dem-v1\manifest.json
```

## 2. ローカルAPI

### 登録スポット200件の事前計算

DEM変換後、ローカルAPIを開始する前に一度実行する。完了済みファイルはSHA-256で検査して再利用するため、中断後は同じコマンドで再開できる。

```powershell
npm.cmd run local-dem:precompute-landmarks
```

出力先:

```text
E:\AstroSight-GSI-data-20260926\dem\r2-ready\precomputed-bearing-profile-v1\
```

既定は10km・360方位・200スポットである。計算済みファイルを追加・更新した場合はローカルAPIを再起動してmanifestを読み直す。生成物はEドライブに置き、GitHubやアプリZIPには含めない。

32 byte以上のランダムなオリジントークンを作り、Windowsの安全な秘密管理先へ保存する。値をリポジトリ、ZIP、ログへ書かない。

```powershell
$env:LOCAL_DEM_ORIGIN_TOKEN = powershell -ExecutionPolicy Bypass -File tools/local-dem-server/new-token.ps1
powershell -ExecutionPolicy Bypass -File tools/local-dem-server/start.ps1
```

サービスは `127.0.0.1` だけで待ち受ける。LAN用の `0.0.0.0`、SMB共有、RDP、ルーターのポート開放は使わない。公開APIは固定の `POST /v1/elevation/batch` と `POST /v1/bearing-profile/precomputed` だけで、ファイル名・パス・一覧・書き込み・削除を受け付けない。前者は1回512地点以下で、後者は登録済み座標と距離がmanifestに完全一致する場合だけ指定方位を返す。本文容量、実行時間、同時実行数にも上限がある。自動モードは最高精度DEMの選択とNoData判定をローカル側で完了し、使用したDEM種別と標高だけを返す。

ローカル確認:

```powershell
Invoke-RestMethod http://127.0.0.1:8789/health
```

応答は `{"ok":true}` だけで、Eドライブのパスやデータ一覧を返さない。

## 3. Cloudflare TunnelとAccess

`tools/local-dem-server/cloudflared-config.yml.example` をリポジトリ外へコピーし、Tunnel UUID、Windowsユーザー名、専用ホスト名を設定する。最後の `http_status:404` は必ず残す。

Cloudflare Zero Trustでその専用ホスト名をSelf-hosted applicationにし、Service AuthポリシーでAstroSight専用Service Tokenだけを許可する。ブラウザーの一般ユーザー認証をDEM APIの許可条件にしない。Service TokenのClient IDとClient Secretは一度しか表示されないため、Cloudflareのsecretとして保存する。

Tunnelは次のローカルサービスだけへ接続する。

```text
http://127.0.0.1:8789
```

オリジントークンはAccess用Client Secretとは別の値にする。Cloudflare Accessが外側でService Tokenを検証し、ローカルAPIが内側で `X-AstroSight-Origin-Token` を定時間比較する。

## 4. Pagesと3つのWorkerに設定するsecret

次の4項目をCloudflare DashboardまたはWranglerのsecret機能で設定する。値は設定ファイルへ直書きしない。

| 名前 | 値 |
|---|---|
| `LOCAL_DEM_API_URL` | `https://<専用ホスト名>/v1/elevation/batch` |
| `LOCAL_DEM_ORIGIN_TOKEN` | 手順2と同じオリジントークン |
| `LOCAL_DEM_ACCESS_CLIENT_ID` | Access Service TokenのClient ID |
| `LOCAL_DEM_ACCESS_CLIENT_SECRET` | Access Service TokenのClient Secret |

設定対象:

- Pagesプロジェクト `astrosight`
- `wrangler.spot-search.jsonc`
- `wrangler.bearing-profile-download.jsonc`
- `wrangler.prewarm.jsonc`

4項目が1つでも欠ける環境ではEドライブ経路を無効として従来経路を使う。途中まで設定された資格情報を送信しない。

## 5. 検査

```powershell
node --test --experimental-strip-types tests/regression/local-dem-gateway.test.mjs tools/local-dem-server/local-dem-server.test.mjs
node scripts/verify-local-dem-origin.mjs
npx tsc -b --pretty false
```

本番接続前に、東京・大阪・札幌・福岡・那覇の5地点をローカルAPIへ送り、値が有限であること、同じ準備済みアセットを読むサーバー計算と一致することを確認する。全DEM種別を確認した後のNoDataだけが `source: null, heightMeters: null` として返り、Cloudflare側で従来どおり地形高0 mの水面・欠測処理へ渡る。

## 停止時の動作

PC停止、Eドライブ切断、Tunnel停止、タイムアウト、計算済みファイルの未登録・破損応答のいずれでも、Cloudflare側は通常の全方位計算へ戻り、さらに必要な地点だけ公開GSIへフォールバックする。Eドライブの失敗を海面や地上高として採用しないため、三脚候補点の精度順は変わらない。
