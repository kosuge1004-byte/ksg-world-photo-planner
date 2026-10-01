export class RawDefectPixelReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RawDefectPixelReferenceError';
  }
}

function fail(message) {
  throw new RawDefectPixelReferenceError(message);
}

function median(values) {
  values.sort((first, second) => first - second);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ?
    values[middle] :
    (values[middle - 1] + values[middle]) * 0.5;
}

export function correctExplicitDefectPixels({
  width,
  height,
  samples,
  points,
}) {
  if (!Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      samples?.length !== width * height ||
      !Array.isArray(points)) {
    fail('RAW defect correction input is invalid');
  }
  const output = Float64Array.from(samples);
  if ([...output].some((value) => !Number.isFinite(value))) {
    fail('RAW defect correction samples must be finite');
  }
  const sortedPoints = points.map(({x, y}) => ({x, y}))
      .sort((first, second) => first.y - second.y || first.x - second.x);
  const defectIndices = new Set();
  for (const {x, y} of sortedPoints) {
    if (!Number.isSafeInteger(x) ||
        !Number.isSafeInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height) {
      fail('RAW defect coordinate is outside the image');
    }
    const index = y * width + x;
    if (defectIndices.has(index)) fail('RAW defect coordinate is duplicated');
    defectIndices.add(index);
  }

  const neighbor = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const index = y * width + x;
    return defectIndices.has(index) ? null : output[index];
  };
  const replacement = (x, y) => {
    const directions = [
      [-2, 0, 2, 0],
      [0, -2, 0, 2],
      [-2, -2, 2, 2],
      [2, -2, -2, 2],
    ];
    let bestEstimate = null;
    let bestDifference = null;
    for (const [x1, y1, x2, y2] of directions) {
      const first = neighbor(x + x1, y + y1);
      const second = neighbor(x + x2, y + y2);
      if (first === null || second === null) continue;
      const difference = Math.abs(first - second);
      const estimate = (first + second) * 0.5;
      if (bestDifference === null || difference < bestDifference) {
        bestDifference = difference;
        bestEstimate = estimate;
      }
    }
    if (bestEstimate !== null) return bestEstimate;
    const fallback = [];
    for (const offsetY of [-2, 0, 2]) {
      for (const offsetX of [-2, 0, 2]) {
        if (offsetX === 0 && offsetY === 0) continue;
        const value = neighbor(x + offsetX, y + offsetY);
        if (value !== null) fallback.push(value);
      }
    }
    return fallback.length === 0 ? null : median(fallback);
  };

  let correctedCount = 0;
  let skippedCount = 0;
  for (const {x, y} of sortedPoints) {
    const value = replacement(x, y);
    if (value === null) {
      skippedCount += 1;
    } else {
      output[y * width + x] = value;
      correctedCount += 1;
    }
  }
  return {
    samples: output,
    correctedCount,
    skippedCount,
  };
}
