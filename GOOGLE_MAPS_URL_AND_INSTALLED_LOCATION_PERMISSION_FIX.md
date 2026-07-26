# Google Maps共有URL・インストール版位置情報案内の修正

## Google Maps共有URL

- 手動転送の200応答で直ちに失敗せず、標準転送による最終URL確認へ進むよう修正
- HTML entity、JavaScript escape、最大4層のpercent encodingを展開
- URL、`data`、JSON形式、Google Maps初期化データから座標を抽出
- 座標を含まない場所名URLは、座標抽出を優先したうえで日本向け地名検索へフォールバック
- HTTP/HTTPS以外の転送先を拒否
- 複数地点を含むGoogle My Maps URLは、誤った1点を選ばず専用メッセージを表示

## 実通信確認

- 東京タワー短縮URLから正式座標を取得
- Google Maps場所共有URL、駅共有URL、Street View共有URLで座標取得
- 場所名だけのGoogle Maps URLで地名検索フォールバックを確認
- 複数地点のMy Maps URLで専用メッセージを確認

## Androidインストール版の位置情報

- `display-mode`に加え、manifestの`source=installed`でもインストール版を判定
- Permissions APIで`granted`・`denied`・`prompt`を確認
- `POSITION_UNAVAILABLE`やタイムアウトでも、権限拒否状態なら権限案内を優先
- Androidのアプリ権限欄に位置情報が表示されない場合があることを明記
- Chromeの対象サイト権限と端末全体の位置情報設定を分けて案内
- ネイティブ設定ブリッジがないPWAでも「設定方法」ボタンを表示

## 確認結果

- `npm run lint` 成功
- `npm run build` 成功
- スマートフォン縦画面で案内の表示・ボタン配置を確認
- ブラウザ警告・エラー0件

