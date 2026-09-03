import fs from 'node:fs';
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const checks = [
  ['imports flyMapToTarget', /import \{ flyMapToTarget \} from "\.\/cesium\/camera";/.test(app)],
  ['subject button flies Cesium camera in 3D', /function showSubjectOnMap\(\)[\s\S]*?mapDisplayMode === "3d"[\s\S]*?flyMapToTarget\([\s\S]*?subjectPoint\.latitude[\s\S]*?subjectPoint\.longitude[\s\S]*?subjectPoint\.height/.test(app)],
  ['tripod button flies Cesium camera in 3D', /function showTripodOnMap\(\)[\s\S]*?mapDisplayMode === "3d"[\s\S]*?flyMapToTarget\([\s\S]*?tripodPoint\.latitude[\s\S]*?tripodPoint\.longitude[\s\S]*?tripodPoint\.height/.test(app)],
  ['current-location button flies Cesium camera in 3D', /async function showCurrentLocation\(\)[\s\S]*?mapDisplayMode === "3d"[\s\S]*?resolveGroundPoint\(latitude, longitude, "現在地3D表示"\)[\s\S]*?flyMapToTarget\(viewer, latitude, longitude/.test(app)],
  ['2D center behavior preserved', (app.match(/setMapCenter\(\{/g) || []).length >= 3],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
