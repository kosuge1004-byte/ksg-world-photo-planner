// Focus-stack photometric normalization (Work353) — Node reference.
//
// Frames of a focus bracket can differ in brightness and colour: effective
// aperture changes with magnification in macro work, LED flicker, or
// per-frame white balance. The focus blend switches frames per pixel, so any
// such difference appears as blotches/steps along winner-map boundaries.
//
// Defocus redistributes light but (away from the frame edge) conserves the
// local mean over blocks much larger than the blur, so the per-channel ratio
// of block means between the reference and an aligned frame estimates that
// frame's gain. The median over valid blocks is robust to the few blocks
// where parallax or specular content differs.

export class InvalidFocusGainInput extends Error {
  constructor(message) { super(message); this.name = 'InvalidFocusGainInput'; }
}

/// `referenceMeans` / `frameMeans`: arrays of [r, g, b] block means for the
/// same output-grid blocks (frame blocks sampled through its alignment).
/// Blocks are used only when every channel of both means lies in
/// [low, high] (linear, white = 1). Returns `{gain: [r, g, b], validBlocks,
/// applied}`; `applied` is false (gain [1,1,1]) when fewer than `minValid`
/// blocks qualify or any gain falls outside [minGain, maxGain].
export function estimateFocusFrameGain(referenceMeans, frameMeans, {
  low = 0.01, high = 0.8, minValid = 30, minGain = 0.5, maxGain = 2,
} = {}) {
  if (referenceMeans.length !== frameMeans.length) throw new InvalidFocusGainInput('Block counts differ.');
  if (!(low > 0 && high > low && high <= 1) || !(minValid >= 1) || !(minGain > 0 && maxGain > minGain)) {
    throw new InvalidFocusGainInput('Invalid gain parameters.');
  }
  const ratios = [[], [], []];
  for (let i = 0; i < referenceMeans.length; i++) {
    const r = referenceMeans[i]; const f = frameMeans[i];
    let ok = true;
    for (let c = 0; c < 3; c++) {
      if (!Number.isFinite(r[c]) || !Number.isFinite(f[c]) || r[c] < low || r[c] > high || f[c] < low || f[c] > high) { ok = false; break; }
    }
    if (!ok) continue;
    for (let c = 0; c < 3; c++) ratios[c].push(r[c] / f[c]);
  }
  const validBlocks = ratios[0].length;
  if (validBlocks < minValid) return { gain: [1, 1, 1], validBlocks, applied: false };
  const median = (v) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const gain = ratios.map(median);
  if (!gain.every((g) => g >= minGain && g <= maxGain)) return { gain: [1, 1, 1], validBlocks, applied: false };
  return { gain, validBlocks, applied: true };
}

/// Output-grid block centres used by the Dart sampler (and tests).
export function focusGainBlockCentres(width, height, { columns = 48, rows = 32, blockSize = 32 } = {}) {
  const centres = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = Math.round((c + 0.5) * width / columns);
      const y = Math.round((r + 0.5) * height / rows);
      if (x - blockSize / 2 < 0 || y - blockSize / 2 < 0 || x + blockSize / 2 > width || y + blockSize / 2 > height) continue;
      centres.push({ x, y });
    }
  }
  return centres;
}
