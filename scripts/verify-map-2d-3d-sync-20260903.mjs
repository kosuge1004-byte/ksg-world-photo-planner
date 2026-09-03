import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const checks = [
  ['toggle uses dedicated synchronizer', /onOpenMap3D=\{toggleMapDisplayMode\}/],
  ['3D to 2D reads displayed center', /if \(mapDisplayMode === "3d"\)[\s\S]*read3DDisplayedCenter\(\)[\s\S]*setMapDisplayMode\("2d"\)/],
  ['displayed center uses canvas center depth pick', /pickSceneSurfacePosition\(viewer, center\)/],
  ['displayed center falls back to globe ray pick', /viewer\.scene\.globe\.pick\(ray, viewer\.scene\)/],
  ['2D to 3D host effect flies to mapCenter', /if \(mapDisplayMode === "3d"\) \{\s*const center = mapCenterRef\.current;\s*flyMapToTarget\(viewer, center\.latitude, center\.longitude\);/],
  ['spot subject search moves 3D camera', /setMapCenter\(center\);\s*if \(mapDisplayMode === "3d" && viewer && !viewer\.isDestroyed\(\)\) \{\s*flyMapToTarget\(viewer, pinned\.latitude, pinned\.longitude, pinned\.height\);/],
  ['spot tripod search moves 3D camera', /setMapCenter\(center\);\s*if \(mapDisplayMode === "3d" && viewer && !viewer\.isDestroyed\(\)\) \{\s*flyMapToTarget\(viewer, tripod\.latitude, tripod\.longitude, tripod\.height\);/],
  ['stored subject moves 3D camera', /function applyStoredSubject[\s\S]*if \(mapDisplayMode === "3d"\) \{\s*flyMapToTarget\(viewer, pinned\.latitude, pinned\.longitude, pinned\.height\);/],
  ['spot preset moves 3D camera', /appliedResult\.subject\.latitude,[\s\S]*appliedResult\.subject\.longitude,[\s\S]*appliedResult\.subject\.height/],
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(src);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
