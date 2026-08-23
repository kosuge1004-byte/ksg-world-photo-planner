# AstroSight 精度維持型パフォーマンス最適化

対象: AstroSight-search-first-confident-prefetch.zip

## 今回変更したもの

1. プレビュー再撮影を3回から2回へ整理
   - 即時描画は維持
   - 3.2秒後の最終高精細描画は維持
   - 最終結果を必ず上書きしていた1.2秒時点の中間再撮影だけ削除
   - 三脚位置・被写体位置・カメラ計算・画角計算・最終画質は変更なし

2. Terrain IndexedDB接続を再利用
   - DBのopen/closeを多点取得のたびに繰り返さない
   - キャッシュキー、標高値、DEM詳細度、有効期限は変更なし

3. Geoid IndexedDB接続を再利用
   - DB接続確立イベントの重複だけ削減
   - ジオイド値、地域キー、有効期限、取得方法は変更なし

4. LOSの中断要求を実際のDEM取得まで伝播
   - 日時・条件変更後に不要になった旧LOS計算をバックグラウンドで継続させない
   - 現在有効なLOS計算のサンプル点数・DEM詳細度・地表屈折補正・計算式は変更なし

## 変更していない精度要素

- 1m / 5m / 10m DEMの使い分け
- 三脚候補の1m最終精密化
- LOSの粗走査/精密走査サンプル数
- WGS84/ECEF/Karney測地計算
- 地表屈折補正
- 天体位置計算
- 三脚候補点の交点計算
- 画角/焦点距離計算
- Google/標準モードの精度設定

## 検証

PASS:
- verify-performance-lifecycle.mjs
- verify-phase6-1-los-performance.mjs
- verify-phase6-2-memory.mjs
- verify-phase6-3-cache-optimization.mjs
- verify-tripod-candidate-performance-resilience.mjs

完全な回帰テストはクリーンGitHub ZIPにnode_modulesを含めない構成のため、この作業環境では依存パッケージ不足で完走不可。
