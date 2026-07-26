# Google Maps URL・インストール版修正

## 原因

スポット検索は Google Maps 共有 URL の展開を
`/api/resolve-google-maps` へ依存していました。

ブラウザ版では同一オリジンの API を利用できますが、Android / iPhone の
インストール版では WebView 内に同 API が存在しないため、共有 URL を解析できませんでした。

## 修正

- Android / iPhone のインストール版は `CapacitorHttp` で Google Maps の転送を直接追跡
- ブラウザ版は従来のサーバー API を継続利用
- 座標を含む通常 URL は通信せず即時解析
- 短縮 URL は自動転送を優先し、失敗時だけ最大 20 回の手動転送へ切り替え
- 転送先を Google Maps 系ホストへ制限
- URL、HTML 初期化データ、地名検索 URL から座標を復元

## 検証

- Google Maps 通常 URL 4 形式
- 共有文に含まれる URL
- 短縮 URL の自動転送
- 短縮 URL の手動転送
- 実在する `maps.app.goo.gl` 共有 URL
- 岐阜城の Google Maps 検索 URL
- TypeScript ビルド
- Lint
- Capacitor Android 同期
- Android ネイティブ設定検査

配布 ZIP には `.env.example` と `node_modules` を含めません。
