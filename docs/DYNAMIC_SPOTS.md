# Dynamic Spot（未登録スポット自動生成）

## 保存場所

通常のEドライブ構成では、ローカルDEMサービスが次の固定場所を選びます。

```text
E:\AstroSight-GSI-data-20260926\
  dynamic-spots-v1\
    manifest.json
    spots\
      dynamic-<座標SHA256先頭32桁>.json
    profiles\
      dynamic-<座標SHA256先頭32桁>\
        bearings\
          000.json ... 359.json
        complete.json.gz
```

`LOCAL_DEM_DATA_ROOT` が標準の `dem\r2-ready` 構成でない場合は、設定済み
データルート直下の `dynamic-spots-v1` を使います。保存場所・ディレクトリ名・
ファイル名をHTTP要求から指定することはできません。

全国のDEM1/DEM5を先に取得しません。不足するDEMタイルだけを既存の
`gsi-decoded-dem-v2/<source>/<zoom>/<x>/<y>.bin` に保存し、すべてのStatic
LandmarkとDynamic Spotで共有します。

## 検索と登録

地点名の解決順は次のとおりです。

1. `src/data/japanLandmarks.ts` のStatic Landmark
2. 端末のDynamic Spot
3. EドライブのDynamic Spot Catalog
4. 既存の地名・座標検索

新規地点は被写体の表示後にバックグラウンド登録を始めます。PCまたはEドライブが
使えない場合も検索・地図・従来の動的計算を失敗扱いにせず、端末レコードを
`pending` のまま保持します。次回の同地点利用時に登録を再送し、Eドライブ側も
起動時に未完了ジョブを再開します。

Static LandmarkのTypeScriptファイルを実行時に編集する処理はありません。

## 高さの出典

構造物は、公式値、PLATEAU実測、OSM `height`、OSM `building:levels` 推定、
未解決を区別して保存します。PLATEAUとOSMを公式値へ昇格しません。高さが
未解決の構造物は `structureHeightMeters: null`、`heightStatus: unknown` の
まま保存し、360方位ジョブを開始せず、`complete` にしません。

地形地点は `subjectSurface: terrain`、`structureHeightMeters: 0` です。

## 360方位と精度

Eドライブ側は既存の `computeBearingProfileBatch` を呼びます。したがって、
距離配列、DEM優先順位、Constrained Bicubic/Bilinear、JPGEO2024、NoData処理は
Static Landmarkと同じです。近隣スポットの座標移動・プロファイル流用はしません。

各方位を即時に別ファイルへ保存します。再起動後は保存済み方位を検査し、欠けた
方位だけを再計算します。次の全条件を満たした場合だけ `complete` になります。

- 正確な座標キー（小数8桁）とスポット記録が一致
- 地形は高さ0、構造物は高さと出典が確定
- 10 km、0〜359度の360方位が存在
- 距離配列が全方位で完全一致
- すべての標高値がfinite
- gzip完成ファイルの書込み、再読込、SHA-256が一致
- manifestとスポット記録のatomic renameが成功

## ローカルAPIの安全策

ローカルサービスは従来どおり `127.0.0.1` のみにlistenし、Cloudflare経由では
origin tokenを必須にします。Dynamic Spot APIが受け取るのは、名称、別名、座標、
分類、高さと出典、または再試行する座標だけです。

任意パス、ファイル名、ディレクトリ、削除、ファイル一覧のAPIはありません。
未対応フィールドを含むJSONも拒否します。書込みは一時ファイルへ行い、内容を
再検証してからatomic renameします。

## R2と料金

Dynamic Spotの完成条件にR2は含まれません。Eドライブと端末キャッシュだけで
動作します。既存のStatic Landmark向けR2経路と、既存のR2無料枠安全予算は
削除・変更していません。新しい有料API、AI API、商用検索API、Cloudflareの
有料サービスや新しいバインディングは追加していません。

