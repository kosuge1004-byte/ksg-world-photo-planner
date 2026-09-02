import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const map2d = fs.readFileSync(new URL('../src/components/Map2DOverlay.tsx', import.meta.url), 'utf8');

// 2026-09-02変更（明示指示により）: 計算中の暫定候補（地形未確認の理論値）
// は地図に表示しない方針に変更した。表示するのは地形確認まで完了した
// 確定候補（tripodCandidates）のみ。以前この検証スクリプトは「暫定候補を
// 先行表示する」挙動を確認していたが、その挙動自体を撤去したため、
// 「撤去されている」ことを確認する内容へ全面的に書き換える。
const checks = [
  ['preliminary candidate state removed from App.tsx (display path no longer builds/tracks it)', !app.includes('preliminaryTripodCandidates')],
  ['displayed candidates come only from confirmed tripodCandidates while idle', /if \(!timelineInteracting \|\| !subjectPoint\) \{[\s\S]{0,400}return tripodCandidates;/.test(app)],
  ['last-confirmed candidates persist through a calculation error (no partial/unconfirmed markers reintroduced)', /if \(canReuseLastConfirmed\) \{[\s\S]*tripodCandidatesRef\.current = lastConfirmedTripodCandidatesRef\.current;/.test(app)],
  ['completed celestial bodies publish confirmed candidates progressively', /\(resolvedId, resolvedCandidates\) =>[\s\S]*setTripodCandidates\(\(current\)/.test(app)],
  ['only the farthest candidate per body is returned by the search itself', fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8').includes('return unique.slice(0, 1);')],
  ['2D map renders and selects every displayed candidate', map2d.includes('candidates.map((candidate)') && map2d.includes('onSelectCandidate(candidate)')],
  ['lower 3D candidate renderer removed', !fs.existsSync(new URL('../src/cesium/celestialMap.ts', import.meta.url))],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
