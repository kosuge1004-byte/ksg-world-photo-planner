import fs from 'node:fs';
const source = fs.readFileSync('src/cesium/tripodCandidates.ts', 'utf8');
const checks = [
  ['initial ground refraction is derived from shared apparent model', /const initialGroundRefractionDegrees\s*=\s*initialSubjectElevation\.apparentAltitudeDegrees\s*-\s*initialSubjectElevation\.geometricAltitudeDegrees/s.test(source)],
  ['initial ray starts from preview apparent celestial altitude', /const initialRayAltitudeDegrees\s*=\s*point\.altitudeDegrees\s*-\s*initialGroundRefractionDegrees/s.test(source)],
  ['authoritative initial seeds come from ECEF ray terrain intersections', /const initialSolutions = \(await scanRayTerrainIntersections\(\s*initialRay,/s.test(source)],
  ['centerline solver is not authoritative in calculateOneCandidates', !/const initialSolutions = await scanCenterlineAlignmentSeeds\(/.test(source)],
  ['candidate reconvergence restores ground-refraction conversion', /const groundRefractionDegrees\s*=\s*candidateSubjectElevation\.apparentAltitudeDegrees\s*-\s*candidateSubjectElevation\.geometricAltitudeDegrees/s.test(source)],
  ['reconverged ray uses apparent celestial altitude minus ground refraction', /const refinedRayAltitudeDegrees\s*=\s*horizontal\.altitudeDegrees\s*-\s*groundRefractionDegrees/s.test(source)],
  ['direct celestial geometric altitude is not used for refined ray', !/const geometricRayAltitudeDegrees\s*=\s*Number\.isFinite\(horizontal\.geometricAltitudeDegrees\)/.test(source)],
  ['camera-height helper remains', source.includes('withLensCenterHeight(')],
  ['point-specific geoid path remains', source.includes('buildPointSpecificFinalCandidateGroundPoint')],
  // 2026-09-01変更: round-trip投影（verifyRoundTripProjection）による
  // フレーミング判定・棄却は明示指示により撤廃した。三脚候補は幾何レイと
  // 地形の交点をそのまま返す設計になったため、この項目は対象を失った。
];
let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
