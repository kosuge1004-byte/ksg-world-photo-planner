import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourcePath = path.join(root, 'src/cesium/tripodCandidates.ts');
const appPath = path.join(root, 'src/App.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const app = fs.readFileSync(appPath, 'utf8');

const checks = [
  ['new centerline solver exists', source.includes('async function scanCenterlineAlignmentSeeds(')],
  ['main search uses centerline solver', source.includes('const initialSolutions = await scanCenterlineAlignmentSeeds(')],
  ['main search no longer seeds from scanInitialRayTerrainIntersections', !/const initialSolutions = await scanInitialRayTerrainIntersections\(/.test(source)],
  ['candidate-specific celestial position is recalculated', /scanCenterlineAlignmentSeeds[\s\S]*calculateCelestialHorizontalCoordinates\(/.test(source)],
  ['subject apparent elevation uses shared model', /scanCenterlineAlignmentSeeds[\s\S]*computeApparentElevation\(/.test(source)],
  ['azimuth residual is solved', /signedAngularDifferenceDegrees\([\s\S]*subjectLine\.bearingDegrees,[\s\S]*celestial\.azimuthDegrees/.test(source)],
  ['altitude residual is solved', source.includes('subjectElevation.apparentAltitudeDegrees - celestial.altitudeDegrees')],
  ['old geometric ray cannot block new solver', !source.includes('if (!initialRay) return [];')],
  ['past preferred distance is not passed into centerline solver ranking', /scanCenterlineAlignmentSeeds\([\s\S]*activeRefractionWeather\n  \);/.test(source)],
  ['centerline diagnostics are exported', source.includes('export function getLastCenterlineScanSamples()')],
  ['centerline diagnostics are copied in UI', app.includes('中心線一次探索（距離m:角距離°[方位差°,仰角差°]）:')],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
