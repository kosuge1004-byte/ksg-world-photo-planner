# 第1段階 精度修正レポート

## 対応済み

1. `src/cesium/camera.ts`
   - `sensorDimensionsMm()` を36×24mm内接方式へ変更。
   - 指定アスペクト比を維持し、幅36mm・高さ24mmを超えない最大撮像領域を返す。

2. `src/cesium/geometry.ts`
   - WGS84/ECEF座標を使用する共通仰角関数 `calculateElevationAngleDegrees()` を追加。

3. `src/search/celestialTransitSearch.ts`
   - 画角内検索の「高さ差÷水平距離」による平面近似を廃止。
   - レンズ中心位置から被写体への仰角をECEF共通関数で計算するよう変更。

## センサー寸法確認値

- 1:1 = 24×24mm
- 4:3 = 32×24mm
- 5:4 = 30×24mm
- 3:2 = 36×24mm
- 16:9 = 36×20.25mm
- 9:16 = 13.5×24mm
- 3:4 = 18×24mm

すべて36×24mm内に収まる。

## ビルド確認

`npm run build`を実行したが、ZIPにnode_modulesが含まれず、依存関係復元時に実行環境側のClientErrorが発生したため、最終ビルド完了は未確認。
最初のビルド停止理由は以下の依存型定義未配置。

- `vite/client`
- `@types/node`

ソースのTypeScriptエラーとして検出されたものではない。
