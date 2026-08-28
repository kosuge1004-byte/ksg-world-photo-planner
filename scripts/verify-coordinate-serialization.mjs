import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const siteContext = read("src/search/siteContext.ts");
assert.match(siteContext, /requestBody[\s\S]*latitude: point\.latitude,[\s\S]*longitude: point\.longitude/);
assert.match(siteContext, /cacheKeyPoints[\s\S]*toFixed\(5\)/);

const terrain = read("src/cesium/worldTerrain.ts");
assert.match(terrain, /const geoidPoints = requested\.map[\s\S]*CesiumMath\.toDegrees\(point\.latitude\)(?!\.toFixed)/);
assert.match(terrain, /const geoidKeyPoints = geoidPoints\.map[\s\S]*toFixed\(4\)/);
assert.match(terrain, /body: JSON\.stringify\(\{ points: geoidPoints, precision: "point" \}\)/);

const geoid = read("server/gsiGeoid.ts");
assert.match(geoid, /const queryLatitude = pointSpecific \? latitude : cacheLatitude/);
assert.match(geoid, /const queryLongitude = pointSpecific \? longitude : cacheLongitude/);

const elevationApi = read("functions/api/gsi-elevation.ts");
assert.match(elevationApi, /lookupGsiElevations\(points,/);
// 2026-08-28追記: 「複数座標をまとめた外側のバッチキャッシュ」
// (cacheKeyInput、toFixed(5)で丸めていた)は撤去した。代わりに使う
// 「DEMタイル単位の永続キャッシュ」は、タイル座標(x, y)自体が既に
// 整数のタイルインデックスであり、緯度経度を丸める必要がない
// （タイル座標の計算はserver/gsiElevation.ts側で行われる）。
const gsiElevationServer = read("server/gsiElevation.ts");
assert.match(gsiElevationServer, /function persistentTileKey\(source: ElevationTileSource, x: number, y: number\)/);

const osmApi = read("functions/api/osm-site-context.ts");
assert.match(osmApi, /lookupOsmSiteContexts\(points,/);
assert.match(osmApi, /cacheKeyInput[\s\S]*toFixed\(5\)/);

console.log("coordinate serialization verification passed");
