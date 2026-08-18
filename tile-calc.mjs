// 富士山の概算座標(35.3606, 138.7274)からXYZタイル番号を計算
function lonLatToTile(lon, lat, z) {
  const x = Math.floor((lon + 180) / 360 * Math.pow(2, z));
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, z));
  return { x, y };
}
for (const z of [12, 13, 14, 15, 16]) {
  const { x, y } = lonLatToTile(138.7274, 35.3606, z);
  console.log(`z=${z}: x=${x}, y=${y} -> https://cyberjapandata.gsi.go.jp/xyz/experimental_nnfpt/${z}/${x}/${y}.geojson`);
}
