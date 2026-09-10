import fs from "node:fs";
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8");
const geo=read("src/types/geospatial.ts");
const osm=read("server/osmSiteContext.ts");
const site=read("src/search/siteContext.ts");
const world=read("src/cesium/worldTerrain.ts");
const tripod=read("src/cesium/tripodCandidates.ts");
const checks=[
 ["water kind separates river",geo.includes('"none" | "river" | "sea-or-other-water"')],
 ["river/canal polygons queried",osm.includes('["water"="river"]')&&osm.includes('["water"="canal"]')],
 ["linear mountain river not globally zeroed",!osm.includes('["waterway"="river"]')],
 ["client validates water kind",site.includes('"waterSurfaceKind" in value')],
 // 2026-09-10更新: 「バッチ全体で1件でも通信失敗があれば全滅」という粗い
 // 判定(result.failedPointCount === 0)は、無関係な1点の失敗が同じバッチ内の
 // 正常な海面0m判定まで道連れにする不具合だったため、点単位の失敗特定
 // (failedIndexes)へ置き換えた。ここではその置き換えが実際に行われている
 // ことと、通信失敗点を無条件でauthoritative扱いしていないことの両方を確認する。
 ["GSI no-data marked per-point, not per-batch",world.includes("result.failedIndexes")&&world.includes("failedIndexSet.has(index)")&&world.includes("authoritativeGsiNoDataBySample.add")&&!world.includes("result.failedPointCount === 0")],
 ["sea/no-data H=0 path retained",world.includes('"GSI_WATER_ZERO"')&&tripod.includes('"water-surface:zero"')],
 ["river nearest-land radial search",tripod.includes("RIVER_NEAREST_LAND_RADII_METERS")&&tripod.includes("RIVER_NEAREST_LAND_BEARINGS_DEGREES")],
 ["nearest sample must be outside mapped water",tripod.includes("contexts[index]?.onWaterSurface")],
 ["river uses nearest-land orthometric height",tripod.includes('"river-surface:nearest-land"')&&tripod.includes("nearestLand.orthometricHeightMeters")],
 ["river is not forced to zero",tripod.includes("riverWaterSurface")&&tripod.includes("seaOrOtherWaterSurface")],
 ["unresolved river preserves terrain height",tripod.includes('"river-surface:fallback"')&&tripod.includes("keep terrain-derived height")],
 ["normal terrain formula retained",tripod.includes("cartographic.height - geoidForOrthometric")],
];
let failed=0; for(const [n,ok] of checks){console.log(`${ok?"PASS":"FAIL"}: ${n}`);if(!ok)failed++;}
if(failed)throw new Error(`water/river regression failed ${failed}/${checks.length}`);
console.log(`Water/river regression: PASS (${checks.length}/${checks.length})`);
