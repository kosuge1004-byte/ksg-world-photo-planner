import fs from 'node:fs';

const overlay = fs.readFileSync(new URL('../src/components/Map2DOverlay.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');

const checks = [
  ['line starts from subject projection', /const start = projectCoordinatesToMapPixel\(line\.start, center, zoom, size\)/.test(overlay)],
  ['line direction has local 1km Karney fallback', /calculateKarneyDestinationPoint\([\s\S]*line\.start,[\s\S]*line\.bearingDegrees,[\s\S]*1_000/.test(overlay)],
  ['line prefers matching candidate coordinate', /matchingCandidate \?\? localDirectionCoordinate/.test(overlay)],
  ['250km endpoint is not used to draw the screen ray', !/const end = projectCoordinatesToMapPixel\(line\.end/.test(overlay)],
  ['candidate point marker exists', /map-tripod-candidate-marker/.test(overlay)],
  ['candidate marker selects candidate', /className=\{`map-tripod-candidate-marker[\s\S]*onClick=\{\(\) => onSelectCandidate\(candidate\)\}/.test(overlay)],
  ['candidate marker CSS exists', /\.map-tripod-candidate-marker\s*\{/.test(css)],
  ['sun marker color exists', /\.map-candidate-marker-sun\s*\{/.test(css)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
