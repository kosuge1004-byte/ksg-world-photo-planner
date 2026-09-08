import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const preview = fs.readFileSync(new URL('../src/cesium/previewSnapshot.ts', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../src/cesium/createMapViewer.ts', import.meta.url), 'utf8');

const checks = [
  ['preview uses one DefaultDataSource visibility toggle', preview.includes('viewer.dataSourceDisplay.defaultDataSource') && !preview.includes('viewer.entities.values.map((entity)')],
  ['preview camera is restored after capture', preview.includes('restoreCamera(viewer, cameraState)')],
  ['preview still renders requested high-quality canvas', preview.includes('pixelRatio = Math.min(window.devicePixelRatio || 1, 2)')],
  ['delayed final preview waits for stable map camera after user movement', app.includes('waitForCameraIdle') && app.includes('700') && app.includes('sameCamera(current, mapCameraAtSchedule)')],
  ['final preview pass remains enabled', app.includes('プレビュー最終更新中') && app.includes('3200')],
  ['Cesium default render loop stays disabled for controlled/manual rendering', app.includes('viewer.useDefaultRenderLoop = false')],
  ['Google 3D LOD quality setting unchanged', viewer.includes('tileset.maximumScreenSpaceError = 24')],
  ['PLATEAU 3D LOD quality setting unchanged', viewer.includes('buildings.maximumScreenSpaceError = 8')],
  ['terrain vertex normals follow the optional terrain shading setting', viewer.includes('requestVertexNormals: terrainShadingEnabled')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`PASS: ${checks.length}/${checks.length} checks`);
