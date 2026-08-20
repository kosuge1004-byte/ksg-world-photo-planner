import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=(p)=>readFile(new URL(`../${p}`, import.meta.url),'utf8');
const transit=await read('src/search/celestialTransitSearch.ts');
const celestial=await read('src/cesium/celestial.ts');
const cameraModelFactory=await read('src/cesium/cameraModelFactory.ts');
const adaptiveTerrainProfile=await read('src/geodesy/adaptiveTerrainProfile.ts');
const viewer=await read('src/cesium/createMapViewer.ts');
const dialog=await read('src/components/CelestialTransitSearchDialog.tsx');
const overlay=await read('src/components/CelestialOverlay.tsx');
const map2d=await read('src/components/Map2DOverlay.tsx');
assert.match(transit,/"direction-crossing"\s*\|\s*"in-frame"/u);
assert.match(transit,/BODY_ORDER[^\n]*\["sun",\s*"moon",\s*"milkyWay"\]/u);
assert.match(transit,/createCameraProjection\(/u);
assert.match(transit,/isCelestialInCameraFrame\(/u);
assert.match(transit,/refineClosestInFrameTime/u);
assert.match(transit,/calculateKarneyLineMetrics/u);
// sensorDimensionsMmは、天体投影（celestial.ts）と手動プラン計算の両方で
// 重複していたセンサーサイズ計算を一本化するため、cameraModelFactory.tsへ
// 移動済み。celestial.tsのcreateCameraProjectionはcreateCameraModel経由で
// これを間接的に使う（重複を持たない）。
assert.match(celestial,/createCameraModel\(/u);
assert.match(cameraModelFactory,/sensorDimensionsMm\(aspectRatio\)/u);
// calculateElevationAngleDegrees（旧名）は、クライアント・サーバーで別々に
// 重複実装されていた地形プロファイル走査ロジックの一本化に伴い、
// elevationAngleDegreesとしてgeodesy/adaptiveTerrainProfile.tsへ移動済み。
assert.match(adaptiveTerrainProfile,/export function elevationAngleDegrees/u);
assert.match(celestial,/Body\.Sun/u);
assert.match(celestial,/Body\.Moon/u);
assert.match(celestial,/Body\.Star2/u);
assert.match(viewer,/createGooglePhotorealistic3DTileset/u);
assert.match(viewer,/onlyUsingWithGoogleGeocoder:\s*true/u);
assert.match(viewer,/TILESET_INITIALIZATION_ATTEMPTS\s*=\s*2/u);
assert.match(dialog,/direction-crossing/u);
assert.match(dialog,/in-frame/u);
assert.match(overlay,/milkyWay/u);
assert.match(map2d,/celestial/u);
console.log('Phase7-3 celestial/3D integration verification: PASS');
