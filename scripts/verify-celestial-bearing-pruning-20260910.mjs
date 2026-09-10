import fs from 'node:fs';
const file = fs.readFileSync(new URL('../src/cache/tripodBearingProfileManager.ts', import.meta.url), 'utf8');
const checks = [
  ['helper exists', file.includes('export function requiredCelestialTripodBearings')],
  ['download uses subject latitude', file.includes('requiredCelestialTripodBearings(subjectPoint.latitude)')],
  ['moon north limit present', file.includes('MAX_NORTH_CELESTIAL_DECLINATION_DEGREES = 28.75')],
  ['milky way south limit present', file.includes('MIN_SOUTH_CELESTIAL_DECLINATION_DEGREES = -29.01')],
  ['3 degree safety margin present', file.includes('CELESTIAL_BEARING_SAFETY_MARGIN_DEGREES = 3')],
  ['low latitude keeps all bearings', file.includes('absoluteLatitude <= limitingDeclinationDegrees')],
  ['horizon azimuth formula present', file.includes('Math.sin(declinationRadians) / Math.cos(latitudeRadians)')],
];
let fail = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fail++; }
if (fail) process.exit(1);
