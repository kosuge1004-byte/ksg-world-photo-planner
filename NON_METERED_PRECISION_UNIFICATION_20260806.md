# 非従量制計算の標準・高精度統一

## 方針
標準モードと高精度モードの差を、従量制のGoogle Photorealistic 3D Tiles / Cesium ion利用部分だけに限定した。

## 変更
- Open-Meteo系の予報・平年気象データ取得を標準モードでも有効化。
- 自動屈折補正を両モードで同一処理に統一。
- 天体計算、Karney測地線、DEM、ジオイド、カメラ投影は従来どおり共通経路を使用。
- UI説明を、標準と高精度の差がGoogle 3Dの建物表面・遮蔽・最終3D確認だけであることが分かる表現へ更新。

## 維持した差分
- 高精度3D Viewer
- Google Photorealistic 3D TilesによるclampToHeightMostDetailed
- Google 3D建物遮蔽・最終メッシュ検証
- 高精度利用量カウンター／停止制御

これらは従量制サービスに関係するため高精度モード限定のまま。
