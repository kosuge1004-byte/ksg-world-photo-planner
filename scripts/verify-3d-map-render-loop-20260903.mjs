import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const preview = fs.readFileSync(new URL('../src/cesium/previewSnapshot.ts', import.meta.url), 'utf8');
const checks = [
  ['3D enables Cesium default render loop', app.includes('viewer.useDefaultRenderLoop = true;')],
  ['3D cleanup disables default render loop', app.includes('viewer.useDefaultRenderLoop = false;')],
  ['3D no longer manually calls scene.render', !/const renderLoop = \(\) =>[\s\S]*?viewer\.scene\.render\(\)/.test(app)],
  ['3D observes host resize', app.includes('new ResizeObserver') && app.includes('resizeObserver?.observe(map3DHostRef.current)')],
  ['preview uses Viewer.render', preview.includes('viewer.render();')],
  ['preview no longer calls Scene.render directly', !preview.includes('viewer.scene.render();')],
  ['2D placement layer remains 2D-only', /mapDisplayMode === "2d" &&\s*\(subjectPlacementActive \|\| tripodPlacementActive \|\| foregroundPlacementActive\)/.test(app)],
];
let failed=0;
for (const [name, ok] of checks) { console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed++; }
if (failed) process.exit(1);
