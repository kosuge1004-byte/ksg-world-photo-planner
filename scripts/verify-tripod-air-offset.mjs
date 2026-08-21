import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const points = fs.readFileSync(new URL('../src/types/points.ts', import.meta.url), 'utf8');
const dialog = fs.readFileSync(new URL('../src/components/PlacementConfirmDialog.tsx', import.meta.url), 'utf8');

const checks = [
  ['3D tripod offset re-resolves ground', /offsetMeters !== 0[\s\S]*?await resolveGroundPoint\([\s\S]*?pickedSurfacePoint\.latitude[\s\S]*?pickedSurfacePoint\.longitude/],
  ['3D tripod uses vertical offset helper', /withVerticalOffset\(groundPoint, offsetMeters, "三脚ピン"\)/],
  ['vertical offset helper is independent of lens-center helper', /export function withVerticalOffset\([\s\S]*?heightSource: "manual"/],
  ['dialog explains 0m surface vs nonzero ground baseline', /三脚で高さを入力した場合は[\s\S]*?0mでは選択した3D表面/],
];

let failed = false;
for (const [name, re] of checks) {
  const source = name.startsWith('vertical offset helper') ? points : name.startsWith('dialog') ? dialog : app;
  const ok = re.test(source);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  failed ||= !ok;
}

// Regression guard: the 3D tripod placement block must not use the lens-center
// helper for the user-entered altitude offset.
const tripodBlock = app.match(/openPlacementConfirm\("tripod", async \(offsetMeters\) => \{[\s\S]*?setTripodPoint\(point\);/);
if (!tripodBlock || /withLensCenterHeight\(.*offsetMeters/.test(tripodBlock[0])) {
  console.log('FAIL: tripod placement no longer misuses withLensCenterHeight for user offset');
  failed = true;
} else {
  console.log('PASS: tripod placement no longer misuses withLensCenterHeight for user offset');
}

process.exit(failed ? 1 : 0);
