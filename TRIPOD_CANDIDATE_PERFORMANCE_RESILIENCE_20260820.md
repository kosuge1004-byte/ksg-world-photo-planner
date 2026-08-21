# 三脚候補点 高速化・安定化（精度維持） 2026-08-20

## 目的
三脚候補点の表示をより高速・安定化し、「三脚候補点の計算に失敗しました」の一時的な通信由来エラーを減らす。位置精度を落とすフォールバックやDEM間引きは行わない。

## 変更
1. 精密探索を固定576分割1回から、32分割×2段階の適応探索へ変更。
   - 最終距離分解能: 576分割相当 → 1024分割相当。
   - 精密化DEM: 従来どおり1m指定。
   - 最大内部サンプル数: 575点 → 62点程度。
2. GSI標高APIの最大同時HTTP要求を16→8へ抑制。
   - 座標・詳細度は間引かない。
   - 適応探索で総要求量が減ったため、過剰並列による回線/サーバー輻輳を避ける。
3. World Terrain fallbackを最大3回再試行。
   - 同じ座標・同じ取得方式のみを再試行し、低精度値で代用しない。
   - retry delay: 250ms, 700ms。
4. createWorldTerrainAsync() が失敗した場合、reject済み terrainPromise を破棄。
   - 一度の初期化失敗が以後の候補計算すべてへ連鎖する状態を防止。
5. 既存の Promise.allSettled による天体ごとの失敗分離を維持。
6. 既存の90日地形キャッシュ、メモリキャッシュ、GSI要求の同一フレーム重複排除を維持。

## 精度について
- 粗探索は従来どおり10m DEMで交差区間を特定。
- 確定用精密探索は従来どおり1m DEM。
- 精密探索の距離分解能は 32^2 = 1024 分割相当で、旧576分割を下回らない。
- 既存の角度収束条件 0.002°、ECEF/見かけ高度計算、最終画角判定は変更していない。
- DEM取得失敗時に被写体高度や0mなどの推測値へ置換しない。

## 検証
`scripts/verify-tripod-candidate-performance-resilience.mjs`
- 適応探索 2 pass / 32 segments
- 1m DEM維持
- 10m粗探索維持
- Promise.allSettled維持
- World Terrain 3回試行
- reject済みprovider promiseの破棄
- GSI最大8並列
- 1024 >= 576
- 62 < 575

`node --experimental-strip-types --check` により変更3ファイルの構文チェック済み。

## 未確認
プロジェクト同梱 node_modules が不完全で geo-tz/index.js が欠落しているため、`npm run build` はprebuild段階で実行不能。これは今回の変更によるTypeScriptエラーではなく、元ZIPの依存ファイル不足によるもの。
