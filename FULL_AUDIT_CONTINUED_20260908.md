# AstroSight 全体監査 継続結果 2026-09-08

対象: AstroSight-full-audit-final-20260908.zip

## 実行結果
- verify-*.mjs: 99本
- PASS: 73
- 非ゼロ終了: 26
- 今回アプリ本体の計算コード変更: なし
- 今回修正: 現行実装を誤判定していた回帰テスト5本

## 現行実装と照合して正常と確認した項目
- 地点別ジオイドN取得: fetchGsiGeoidHeightPointSpecific(cartographic, signal, pointGeoidTimeoutMs)
- DEM datum: H = h - N(sample), hFinal = H + N(point-specific)
- 地点別N失敗時: 同一地形サンプル由来Nがある場合だけfallback
- fallback可能時1.2秒 / fallback不能時15秒
- 初期・候補・最終収束観測点のcamera lens center height統一
- 河川候補: 最寄り陸地Hを保持し候補地点Nでhを再構成

## 更新した陳腐化テスト
- verify-point-geoid-fast-fallback-20260830.mjs
- verify-tripod-camera-height-20260823.mjs
- verify-tripod-final-geoid-fallback-propagation-20260830.mjs
- verify-tripod-geoid-datum-20260823.mjs
- verify-tripod-terrain-cache-datum-v3-20260830.mjs

いずれもアルゴリズムを旧仕様へ戻さず、現在の関数名・現在のdatum経路を検証するよう更新。更新後すべてPASS。

## 残る26本の主分類
### 検証環境/テストハーネス
- node_modules不足: typescript, geographiclib-geodesic, geo-tz 等
- Nodeが.tsを直接importする旧runtime test
- Android同期済みWeb assets不在

### 現仕様と不一致の旧テスト
- 旧centerline solver
- 旧apparent-preview seed
- 旧CameraModel round-trip
- 通常短タップで被写体ピンを要求する旧UI
- 三脚手動air-offset UI
- Cesium default render loop / terrain normals常時ON
- Cesium Usage旧ラベル
- Phase4/Phase6/Phase7の過去構造・過去オプション名に対する文字列一致

## 判定
今回精査したジオイド・datum・camera-height群では、追加のアプリ本体不具合は確認されなかった。残る26本は引き続き個別分類が必要であり、26件のアプリ不具合を意味しない。
