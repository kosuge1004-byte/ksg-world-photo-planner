# AstroSight 三脚候補 精度・速度両立修正 2026-08-22

## 目的
32点の対数粗探索で、同一区間内に +→-→+ のような複数交差がある場合の取りこぼしを減らしつつ、全域を1m DEM高密度走査して速度を悪化させない。

## 実装
- 初期32点対数走査は維持。
- 粗探索は10m DEMのまま。
- 粗点間隔が500mを超えないよう、10m DEMサンプルを一括追加。
- 同符号でもレイへ接近している区間は100m以下へ追加細分化。
- 1m DEMは実際に検出した交差区間の精密化だけに使用。
- 複数交点の1m精密化を交点ごとの逐次通信から、pass単位の一括DEM取得へ変更。
- 最終候補について画角条件は使わず、方位角・仰角の幾何収束だけを再確認。
- 最終候補位置で気象依存屈折条件も再解決してから収束確認。

## 精度に関して変更していないもの
- WGS84/ECEF/Karney計算
- 地球曲率・Apparent層
- 1m DEMによる最終交点精密化
- 0.002度の幾何収束閾値
- 画角による候補除外は復活させていない

## 速度対策
- 全域1m高密度化はしていない。
- 粗探索の追加点は10m DEMでまとめて取得。
- 50km全域の粗走査は32点から概ね121点（500m上限）になる。
- 複数交点の1m精密化は1交点ずつではなく一括取得。
- 追加細分化はレイ近傍区間だけ。

## 検証
PASS:
- verify-tripod-adaptive-intersections.mjs
- verify-tripod-adaptive-synthetic.mjs
- verify-tripod-candidate-performance-resilience.mjs
- verify-performance-lifecycle.mjs
- verify-phase6-1-los-performance.mjs
- verify-phase6-2-memory.mjs
- verify-phase6-3-cache-optimization.mjs
- verify-celestial-occlusion-stability.mjs

人工地形テストでは、従来32点では検出できない同一区間内の二重交差を、追加粗走査で2つの交差区間として検出できることを確認。

## 未保証事項
DEMは離散データなので、サンプル間隔より狭い局所地形による交差を数学的に100%取りこぼさない保証はできない。今回の修正は従来32点より検出能力を大きく上げつつ、全域1m走査による大幅な速度悪化を避ける設計。

## ビルド
GitHubクリーン構成にはnode_modulesを含めていないため、この環境では `tsc -b` が vite/client, node, @cloudflare/workers-types の型定義不足で完走しない。今回変更したロジック向け静的検証スクリプトはPASS。
