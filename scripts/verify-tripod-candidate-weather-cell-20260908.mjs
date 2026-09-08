import fs from 'node:fs';

const source = fs.readFileSync('src/cesium/tripodCandidates.ts', 'utf8');
const checks = [
  ['candidate weather cache exists', /candidateWeatherByCell\s*=\s*new Map/.test(source)],
  ['weather cell uses same 0.05 degree rounding', /Math\.round\(candidate\.latitude \* 20\) \/ 20/.test(source) && /Math\.round\(candidate\.longitude \* 20\) \/ 20/.test(source)],
  ['candidate point is passed to resolver', /refractionWeatherResolver\(candidate, signal\)/.test(source)],
  ['candidate-cell promise is reused', /candidateWeatherByCell\.get\(key\)/.test(source) && /candidateWeatherByCell\.set\(key, pending\)/.test(source)],
  ['candidate celestial calculation uses candidate weather', /calculateCelestialHorizontalCoordinates\([\s\S]*?candidateRefractionWeather\s*\)/.test(source)],
  ['candidate weather is resolved before candidate celestial calculation', /candidateRefractionWeather\s*=\s*await resolveCandidateWeather\(candidatePoint\)/.test(source)],
  ['legacy seed kinds removed', !/seedKind\??:/.test(source) && !/"apparent-preview"\s*\|\s*"centerline"/.test(source)],
];
let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log(`Tripod candidate weather-cell regression: PASS (${checks.length}/${checks.length})`);
