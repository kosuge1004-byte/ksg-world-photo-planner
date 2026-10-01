export function buildLinearDngTransparencyMask(interleavedCounts) {
  if (interleavedCounts.length % 3 !== 0) {
    throw new RangeError('Contribution sample count must be divisible by 3.');
  }
  const mask = new Uint8Array(interleavedCounts.length / 3);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const base = pixel * 3;
    mask[pixel] =
      interleavedCounts[base] > 0 &&
      interleavedCounts[base + 1] > 0 &&
      interleavedCounts[base + 2] > 0 ? 255 : 0;
  }
  return mask;
}

export function summarizeLinearDngTransparencyMask(mask) {
  let validPixelCount = 0;
  for (const value of mask) if (value === 255) validPixelCount++;
  return {
    validPixelCount,
    invalidPixelCount: mask.length - validPixelCount,
  };
}
