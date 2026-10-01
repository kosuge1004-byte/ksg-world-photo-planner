import assert from 'node:assert/strict';
import test from 'node:test';

// Work364: the comparison-light merge (Dart `mergeStarTrailFrameIntoRolling
// Accumulator`) keeps the earlier value on ties (strict `>`). Merging the
// frames that cannot receive exclusions first and the rest afterwards must
// give the same bits, except when a +0.0/-0.0 tie occurs — which the merge
// reports so the job falls back to the in-order pass. This test checks that
// claim exhaustively on random data with many ties and signed zeros.

function merge(state, frame, weight, valid, onTie) {
  const out = new Float32Array(frame.length); const counts = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const w = Math.fround(frame[i] * weight);
    const priorValid = state && state.counts[i] !== 0; const frameValid = valid[i];
    if (priorValid && frameValid) {
      const old = state.values[i];
      out[i] = w > old ? w : old; counts[i] = 1;
      if (onTie && w === 0 && old === 0 && (Object.is(w, -0) !== Object.is(old, -0))) onTie();
    } else if (priorValid) { out[i] = state.values[i]; counts[i] = 1; }
    else if (frameValid) { out[i] = w; counts[i] = 1; }
    else { out[i] = 0; counts[i] = 0; }
  }
  return { values: out, counts };
}

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const bits = (a) => Buffer.from(a.buffer).toString('hex');

test('fused order equals in-order merge whenever no signed-zero tie is reported', () => {
  let ties = 0; let checked = 0;
  for (let trial = 0; trial < 400; trial++) {
    const r = lcg(trial + 1);
    const n = 64; const frames = 12;
    const values = [0, -0, 0.25, 0.5, 0.5, 1, -0.25];
    const data = Array.from({ length: frames }, () => Float32Array.from({ length: n }, () => values[Math.floor(r() * values.length)]));
    const valid = Array.from({ length: frames }, () => Array.from({ length: n }, () => r() > 0.1));
    const weights = Array.from({ length: frames }, (_, f) => (f === 0 || f === frames - 1 ? 0.5 : 1));
    const flagged = Array.from({ length: frames }, () => r() < 0.4);
    let inOrder = null;
    for (let f = 0; f < frames; f++) inOrder = merge(inOrder, data[f], weights[f], valid[f], null);
    let fused = null; let tie = false;
    for (let f = 0; f < frames; f++) if (!flagged[f]) fused = merge(fused, data[f], weights[f], valid[f], null);
    for (let f = 0; f < frames; f++) if (flagged[f]) fused = merge(fused, data[f], weights[f], valid[f], () => { tie = true; });
    if (tie) { ties++; continue; }
    checked++;
    assert.equal(bits(fused.values), bits(inOrder.values), `trial ${trial}`);
    assert.deepEqual([...fused.counts], [...inOrder.counts]);
  }
  assert.ok(checked > 50 && ties > 0, `checked=${checked} ties=${ties}`);
});
