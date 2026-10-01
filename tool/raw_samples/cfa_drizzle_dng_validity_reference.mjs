export function buildRgbTransparencyMask({
  interleavedCoverage,
  interleavedSaturationCoverage,
  interleavedSaturationDecisionCoverage,
  minimumCoverage,
  minimumSaturationFraction = 0.5,
}) {
  if (!Number.isFinite(minimumCoverage) || minimumCoverage <= 0) {
    throw new RangeError('minimumCoverage must be finite and positive');
  }
  if (!Number.isFinite(minimumSaturationFraction) ||
      minimumSaturationFraction <= 0 || minimumSaturationFraction > 1) {
    throw new RangeError('minimumSaturationFraction must be in (0, 1]');
  }
  if (interleavedCoverage.length % 3 !== 0) {
    throw new RangeError('coverage length must be divisible by 3');
  }
  if (interleavedSaturationCoverage &&
      interleavedSaturationCoverage.length !== interleavedCoverage.length) {
    throw new RangeError('saturation coverage length mismatch');
  }
  if (interleavedSaturationDecisionCoverage &&
      !interleavedSaturationCoverage) {
    throw new RangeError('saturation decision coverage requires saturation coverage');
  }
  if (interleavedSaturationDecisionCoverage &&
      interleavedSaturationDecisionCoverage.length !== interleavedCoverage.length) {
    throw new RangeError('saturation decision coverage length mismatch');
  }
  const mask = new Uint8Array(interleavedCoverage.length / 3);
  for (let p = 0; p < mask.length; p++) {
    const b = p * 3;
    let valid = true;
    for (let c = 0; c < 3; c++) {
      const surviving = interleavedCoverage[b + c];
      if (!Number.isFinite(surviving) || surviving < 0 || surviving < minimumCoverage) {
        valid = false;
        break;
      }
      if (interleavedSaturationCoverage) {
        const saturated = interleavedSaturationCoverage[b + c];
        const decision = interleavedSaturationDecisionCoverage
          ? interleavedSaturationDecisionCoverage[b + c]
          : surviving;
        if (!Number.isFinite(saturated) || saturated < 0 ||
            !Number.isFinite(decision) || decision < 0) {
          throw new RangeError('saturation coverage must be finite and non-negative');
        }
        const observed = decision + saturated;
        if (observed > minimumCoverage &&
            saturated / observed >= minimumSaturationFraction) {
          valid = false;
          break;
        }
      }
    }
    mask[p] = valid ? 255 : 0;
  }
  return mask;
}

function cfaColorIndexRggb(x, y) {
  const ex = (x & 1) === 0;
  const ey = (y & 1) === 0;
  if (ex && ey) return 0;
  if (!ex && !ey) return 2;
  return 1;
}

function dilateChebyshev(invalid, width, height, radius) {
  const out = new Uint8Array(invalid.length);
  for (let i = 0; i < invalid.length; i++) {
    if (!invalid[i]) continue;
    const y = Math.floor(i / width);
    const x = i - y * width;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
        out[yy * width + xx] = 1;
      }
    }
  }
  return out;
}

export function buildDemosaicTransparencyMaskRggb({
  width,
  height,
  interleavedCoverage,
  minimumCoverage,
  reconstructedInvalid,
  radius = 5,
}) {
  if (!Number.isFinite(minimumCoverage) || minimumCoverage <= 0) {
    throw new RangeError('minimumCoverage must be finite and positive');
  }
  const sourceInvalid = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const c = cfaColorIndexRggb(x, y);
      const coverage = interleavedCoverage[p * 3 + c];
      if (!Number.isFinite(coverage) || coverage < 0) {
        throw new RangeError('coverage must be finite and non-negative');
      }
      if (
        coverage < minimumCoverage ||
        reconstructedInvalid?.[p]
      ) {
        sourceInvalid[p] = 1;
      }
    }
  }
  const influenced = dilateChebyshev(sourceInvalid, width, height, radius);
  return Uint8Array.from(influenced, (v) => v ? 0 : 255);
}
