# Google Maps共有URL解析 Cloudflare全面修正

## 対応URL

- `https://maps.app.goo.gl/*`
- `https://goo.gl/maps/*`
- `https://www.google.com/maps/*`
- `https://maps.google.com/*`

入力URLは上記Google Maps形式だけを受理し、転送中はGoogle管理ホストだけを許可します。

## 解決順序

1. URL自身の正式座標、Place ID、Maps Feature ID、CID、地点名を解析
2. Cloudflare Pages Functionの`fetch(..., { redirect: "manual" })`で最大20回までLocationを追跡
3. Locationが得られない特殊な3xxだけ`redirect: "follow"`へ切り替え
4. 最終URLと現在のGoogle Maps HTMLからcanonical、OG URL、meta refresh、JavaScript転送、構造化座標を解析
5. `GOOGLE_MAPS_API_KEY`設定時はPlaces API (New)でPlace ID、名称、住所、正式座標を補完
6. APIキーなし、またはPlaces APIで解決できない地点名はNominatimで座標・表示住所を補完

Google Maps HTMLのstatic mapや`APP_INITIALIZATION_STATE`に含まれる地図表示中心は、名前付き地点の正式座標とは限りません。このため、表示中心座標を対象地点として採用しません。

## 成功レスポンス

既存の`latitude`、`longitude`、`resolvedUrl`を維持し、次を追加しました。

- `label`
- `place.placeId`
- `place.placeIdType`
- `place.googleMapsFeatureId`
- `place.cid`
- `place.name`
- `place.formattedAddress`
- `place.query`
- `diagnostics.requestId`
- `diagnostics.redirectChain`
- `diagnostics.attempts`
- `diagnostics.extractionSource`

`0x...:0x...`はGoogle Maps Feature IDであり、Places APIの`ChIJ...`形式とは区別して`placeIdType`を返します。`GOOGLE_MAPS_API_KEY`が有効な場合はPlaces API Place IDを優先し、Feature IDも併記します。

## エラーレスポンス

エラー時は次をJSONで返し、同じ内容をCloudflare Logsへ`console.error`で記録します。

- `error`
- `code`
- `requestId`
- `details.sourceUrl`
- `details.finalUrl`
- `details.redirectCount`
- `details.redirectChain`
- `details.attempts`
- `details.elapsedMs`

HTML本文やAPIキーはログへ出力しません。HTTPエラー本文は診断用に最大300文字へ制限しています。

## 実URL確認

`scripts/verify-google-maps-url-live.mjs`はPages Functionハンドラーへ次をPOSTし、JSON応答を検証します。

```text
https://maps.app.goo.gl/by9q32wUuTdT3AVN8?g_st=ac
```

期待値は岐阜城付近の`35.4339171, 136.782051`、Maps Feature ID、地点名、最終Google Maps URL、リダイレクト診断です。

Wrangler Pages dev上の実HTTP確認結果：

- `POST /api/resolve-google-maps`: HTTP 200
- `Content-Type`: `application/json; charset=utf-8`
- 座標: `35.4339171, 136.782051`
- Maps Feature ID: `0x6003a9798f2e0eab:0x2871c3655542c94a`
- 地点名: `岐阜城`
- リダイレクト: 302から最終200まで追跡
