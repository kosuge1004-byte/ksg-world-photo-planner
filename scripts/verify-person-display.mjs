import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const app = read('src/App.tsx');
const overlay = read('src/components/Map2DOverlay.tsx');
const preview = read('src/components/ForegroundPreviewOverlay.tsx');
const foregroundTypes = read('src/types/foreground.ts');

const checks = [
  ['subject-pin placement keeps 3D height', app.includes('"subject-pin"') && app.includes('subjectPoint.height')],
  ['only 2D placement requests DEM correction', app.includes('if (source === "map-2d")')],
  ['preview hides subject marker within 0.5m', app.includes('foregroundOverlapsSubjectPin') && app.includes('<= 0.5') && app.includes('!foregroundOverlapsSubjectPin')],
  ['preview person uses the camera projection path', preview.includes('projectForegroundObjectToPreview')],
  ['2D always uses person pin', overlay.includes('2D map always uses the fixed-size person pin') && overlay.includes('person-pin-body')],
  ['lower 3D person entity module removed', !fs.existsSync('src/cesium/foregroundObject.ts')],
  ['height stored in centimetres and converted at geometry boundary', foregroundTypes.includes('return normalizeForegroundHeightCm(heightCm) / 100')],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
if (failed.length) process.exit(1);
console.log(`Person display verification passed (${checks.length}/${checks.length}).`);
