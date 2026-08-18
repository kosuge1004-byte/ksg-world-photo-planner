# 光害タイルレイヤー追加（2026-08-11）

## 実装内容
- 天体メニューで「天の川」がONのときだけ「光害マップ」チェックボックスを表示。
- 光害マップをONにすると、NASA EOSDIS GIBS の `VIIRS_Black_Marble` WMTSタイルを半透明表示。
- 2D表示ではGoogleマップiframe上にWeb Mercatorで位置合わせしたタイルを重ねる。
- 標準Cesium 3D表示ではImageryLayerとして同じタイルを追加する。
- 高精度Google Photorealistic 3D Tilesは外部WMTSの直接ドレープに対応しないため、光害マップON時は位置精度を優先して2D表示へ自動切替する。
- 天の川をOFFにした場合は光害マップも自動でOFF。
- NASA EOSDIS GIBS / VIIRS Black Marble のクレジットを表示。

## データURL
`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`

## 注意
このレイヤーはVIIRS Black Marbleによる地上の夜間光分布であり、空のskyglowそのものを直接測定したマップではない。今回はユーザー指示どおり「光害マップのタイル表示」だけを先行実装し、撮影可否判定・凡例・skyglow換算は追加していない。
