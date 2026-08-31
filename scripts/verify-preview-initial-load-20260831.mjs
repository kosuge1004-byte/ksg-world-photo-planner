import fs from 'node:fs';

const preview = fs.readFileSync(new URL('../src/cesium/previewSnapshot.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

const checks = [
  ['Cesium preview render loop is intentionally disabled', app.includes('viewer.useDefaultRenderLoop = false')],
  ['preview waits/pumps tiles before capture completes', preview.includes('await waitForPreviewTiles(viewer, previewCanvas, context)')],
  ['wait loop actively renders while auto loop is disabled', preview.includes('viewer.scene.requestRender()') && preview.includes('viewer.scene.render()')],
  ['each loading frame is copied automatically to upper preview', preview.includes('copyViewerFrameToPreview(viewer, previewCanvas, context)')],
  ['Google/3D Tiles load completion is checked', preview.includes('primitive.tilesLoaded')],
  ['terrain/globe load completion is checked', preview.includes('globe.tilesLoaded')],
  ['tile wait has a finite timeout', preview.includes('PREVIEW_TILE_WAIT_TIMEOUT_MS = 8_000')],
  ['camera restore remains in finally', preview.includes('finally {') && preview.includes('restoreCamera(viewer, cameraState)')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`PASS: ${checks.length}/${checks.length} checks`);
