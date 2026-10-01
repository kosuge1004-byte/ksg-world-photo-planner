import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const manager = fs.readFileSync(new URL('../src/cache/tripodBearingProfileManager.ts', import.meta.url), 'utf8');

const checks = [
  [
    'App accepts bearing-profile fast path only when at least one confirmed candidate exists',
    /if \(bearingProfileResult && bearingProfileResult\.length > 0\)/.test(app),
  ],
  [
    'bearing-profile zero-result falls back to authoritative full search',
    /if \(collected\.length === 0\) \{[\s\S]*?return null;[\s\S]*?\}\s*return collected;/.test(manager),
  ],
  [
    'bearing-profile partial per-celestial results also fall back instead of returning incomplete complete-state data',
    /const verifiedForPoint: TripodCandidate\[\] = \[\];[\s\S]*?if \(verifiedForPoint\.length === 0\) return null;[\s\S]*?collected\.push\(\.\.\.verifiedForPoint\);/.test(manager),
  ],
  [
    'bearing-profile ray uses the same initial observer frame as authoritative search',
    /const rayDirectionObserver = initialDirectionObserver \?\? withLensCenterHeight\([\s\S]*?buildCelestialBackwardRay\([\s\S]*?geometricRayAltitudeDegrees,[\s\S]*?rayDirectionObserver[\s\S]*?\)/.test(manager),
  ],
  [
    'bearing-profile removes terrestrial apparent/geometric refraction before ECEF ray construction',
    /initialGroundRefractionDegrees[\s\S]*?apparentAltitudeDegrees[\s\S]*?geometricAltitudeDegrees[\s\S]*?geometricRayAltitudeDegrees = altitudeDegrees - initialGroundRefractionDegrees/.test(manager),
  ],
  [
    'bearing-profile no-sign-change path keeps the closest finite sample for narrow live verification',
    /if \(brackets\.length === 0\) \{[\s\S]*?finiteErrors[\s\S]*?Math\.abs\(current\.error\) < Math\.abs\(best\.error\)[\s\S]*?return \[profile\.points\[closest\.index\]\.distanceMeters\];/.test(manager),
  ],
  [
    'old subject-ENU apparent-altitude shortcut is absent',
    !/buildCelestialBackwardRay\(subjectPoint, azimuthDegrees, altitudeDegrees\)/.test(manager),
  ],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  failed ||= !ok;
}

if (failed) process.exit(1);
