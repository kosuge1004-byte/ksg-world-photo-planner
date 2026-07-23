# KSG World Photo Planner

スマートフォン縦画面向けの高精度撮影計画アプリです。Cesium、Google Photorealistic 3D Tiles、Astronomy Engine、国土地理院DEM、OpenStreetMapを組み合わせて、太陽・月・天の川・北極星と被写体の構図を計算します。

## 開発起動

1. プロジェクト直下の `.env.local` に `VITE_CESIUM_ION_TOKEN` を設定します。
2. PowerShellで次を実行します。

```powershell
npm.cmd install
npm.cmd run dev
```

## 検査

```powershell
npm.cmd run lint
npm.cmd run build
```

## バックグラウンド日時検索

- Netlify Background Functionsで検索を継続します。
- ジョブ状態と結果はNetlify Blobsへ保存します。
- ホーム画面や他アプリへ移動してブラウザー処理が停止しても、サーバー検索は継続します。
- アプリ再起動時は保存したジョブIDから検索画面へ復帰します。
- サーバーでGSI DEMによる地形遮蔽を確認後、端末のCesiumでGoogle 3D建物・表面の最終遮蔽を確認します。
- `npm.cmd run dev` では同じAPIを開発サーバー内メモリーで再現します。

Netlify FunctionsでWorld Terrainへフォールバックする場合は、サーバー専用の `CESIUM_ION_TOKEN` も設定できます。未設定時は `VITE_CESIUM_ION_TOKEN` を使用します。

## 地理条件

- 「道路・道の上のみ」はOSMの `highway` 形状と実幅を使って判定します。
- 通行条件判定は建物・ランドマーク照会から分離し、Overpassの504を抑えています。
- 判定不能な地点を通行可能と推測して採用することはありません。
- 3D手動配置では橋面などクリックした実在表面の高さを保持します。

## 配布

認証情報を含む `.env*`、`node_modules`、`dist`、ブラウザー検査キャッシュは配布ZIPへ含めないでください。
