import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
const effectStart = app.indexOf('const tapHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);');
const effectEnd = app.indexOf('// Viewerの標準ループ', effectStart);
const handler = app.slice(effectStart, effectEnd);

const checks = [
  ['3D subject placement uses explicit scene surface', handler.includes('setSubjectPinFromExplicit3dPick')],
  ['3D tripod placement uses explicit scene surface', handler.includes('setTripodPinFromExplicit3dPick')],
  ['3D foreground placement uses resolved 3D surface', handler.includes('resolveGroundPointFrom3dSurface') && handler.includes('map-3d-surface')],
  ['3D placement mode is not rejected by old guard', !handler.includes('subjectPlacementActive || tripodPlacementActive || foregroundPlacementActive')],
  ['3D failed surface pick reports to lower status', handler.includes('3D表面を取得できませんでした')],
  ['old map candidate status popup removed', !app.includes('className={`map-tripod-candidate-status ${tripodCandidateCalculationStatus}')],
  ['candidate state rendered in app status', app.includes('app-status-candidate')],
  ['3D controls receive dedicated mode class', app.includes('map-mode-3d')],
  ['3D pin rail is transparent and non-flexing', css.includes('.map-controls-layer.map-mode-3d .map-tool-rail') && css.includes('flex: 0 0 auto;') && css.includes('background: transparent;')],
  ['3D pin button sits before zoom control in DOM', app.indexOf('className={`map-pin-tool-button') < app.indexOf('className="map-zoom-control"')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`PASS: ${checks.length}/${checks.length}`);
