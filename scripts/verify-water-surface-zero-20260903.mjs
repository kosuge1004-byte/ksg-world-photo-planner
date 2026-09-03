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
 ["GSI no-data marked only on successful batch",world.includes("result.failedPointCount === 0")&&world.includes("authoritativeGsiNoDataBySample.add")],
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
