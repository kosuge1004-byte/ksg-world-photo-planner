# AstroSight 検索エンジン除外設定

実施日: 2026-08-02

## 実装

- `index.html`へ汎用の`<meta name="robots" content="noindex, nofollow" />`を追加しました。
- `public/_headers`を追加し、Cloudflare Pages／Workers Static Assetsの全静的レスポンスへ`X-Robots-Tag: noindex, nofollow`を設定しました。
- 現在のNetlify公開にも同じ指定が適用されるよう、`netlify.toml`へ`X-Robots-Tag`を追加しました。
- `robots.txt`による全クロール禁止は追加していません。クローラーがページとHTTPヘッダーを取得し、`noindex`を確認できる構成です。
- `scripts/verify-search-engine-exclusion.mjs`を追加し、設定の欠落や競合する`robots.txt`を回帰検知します。

## 効果と限界

`robots`はGoogle専用ではなく、命令をサポートする検索エンジン全般が対象です。公開URLを知っている利用者は引き続きアプリへアクセスできます。

検索除外命令に従わないクローラーや第三者のアクセスまでは防止しません。内容自体を非公開にする場合は、Cloudflare Access、パスワード、ログイン認証、IP制限などが別途必要です。

すでに検索結果へ登録済みのURLは、各検索エンジンの再クロール後に除外されます。即時削除が必要な場合は各Webmaster管理画面から削除を申請してください。
