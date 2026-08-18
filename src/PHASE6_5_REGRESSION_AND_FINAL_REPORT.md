# AstroSight Phase6-5 回帰テスト・最終監査

## 対象

- 入力: AstroSight-phase6-4-search-speed.zip
- Phase6-1〜6-4の高速化変更を含む最終統合版

## 実施内容

1. Phase6-1〜6-4専用検証を再実行
2. 全 verify スクリプトを個別実行
3. キャッシュ・LOS・検索速度・PWA・Cloudflare・端末互換契約を監査
4. 旧回帰検証の定数名依存を、現行の共有キャッシュポリシー検証へ更新
5. ZIP構造と格納ファイルを確認

## 検証結果

### 通過

- 依存不要検証: 32件通過
- Phase6-1 LOS高速化検証: 通過
- Phase6-2 メモリ削減検証: 通過
- Phase6-3 キャッシュ最適化検証: 通過
- Phase6-4 検索速度検証: 通過
- performance/lifecycle検証: 通過

### 実行不能または環境依存

- TypeScriptソースを直接読み込む検証: `typescript`パッケージ未配置のため実行不能
- GeographicLibを利用する検証: 依存パッケージ未配置のため実行不能
- Android同期資産検証: Capacitor同期済みWeb資産がZIPに含まれないため実行不能
- Google Maps live検証: 外部ネットワーク依存のため未実行
- `npm ci`: 内部npmレジストリで `youch-core-0.3.3` が404となり依存復元不能
- `npm run build`: 上記依存復元不能のため未実行

## 回帰テスト側の修正

`verify-performance-lifecycle.mjs` が、Phase5で共有キャッシュポリシーへ移行する前の
`WEATHER_CACHE_MAX_ENTRIES` 定数名を要求していました。

実装側には以下の上限が既に存在します。

- `DEVICE_CACHE_POLICIES.weatherForecast`
- `DEVICE_CACHE_POLICIES.weatherClimatology`

検証を現行構造に合わせ、共有ポリシーへの接続と両キャッシュ定義を確認するよう更新しました。
製品ロジック、TTL、最大件数、検索結果には変更ありません。

## Phase6総括

- Phase6-1: LOS直列待ち削減・一時オブジェクト削減
- Phase6-2: 地形取得とOSM候補保持のメモリ削減
- Phase6-3: LRU・IndexedDB整理・サーバーキャッシュ最適化
- Phase6-4: タイムゾーン変換共有・曜日判定高速化
- Phase6-5: 回帰監査・旧検証更新・最終統合

## 未確認事項

依存パッケージを正常取得できる環境で、以下を最終確認する必要があります。

```bash
npm ci
npm run build
npm run test:regression
```

Android版はさらに以下を実行してください。

```bash
npm run android:sync
npm run verify:android
```
