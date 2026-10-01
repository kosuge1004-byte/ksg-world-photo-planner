export class AffineResamplingCancelled extends Error {
  constructor() {
    super('Affine RGB tile resampling was cancelled.');
    this.name = 'AffineResamplingCancelled';
  }
}

export function identitySamplingTransform() {
  return samplingTransform({
    m00: 1, m01: 0, m02: 0,
    m10: 0, m11: 1, m12: 0,
  });
}

export function similaritySamplingTransform({
  rotationDegrees,
  sourceOffsetX,
  sourceOffsetY,
  centerX,
  centerY,
}) {
  assertFinite([
    rotationDegrees,
    sourceOffsetX,
    sourceOffsetY,
    centerX,
    centerY,
  ], 'Similarity parameters');
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return samplingTransform({
    m00: cosine,
    m01: -sine,
    m02: centerX - cosine * centerX + sine * centerY + sourceOffsetX,
    m10: sine,
    m11: cosine,
    m12: centerY - sine * centerX - cosine * centerY + sourceOffsetY,
  });
}

export function samplingTransform(coefficients) {
  const {m00, m01, m02, m10, m11, m12} = coefficients;
  assertFinite([m00, m01, m02, m10, m11, m12], 'Affine coefficients');
  return Object.freeze({m00, m01, m02, m10, m11, m12});
}

export function sampleAffineRgbTile({
  frame,
  width,
  height,
  outputX,
  outputY,
  outputWidth,
  outputHeight,
  transform,
  isCancelled = () => false,
}) {
  validateInput({
    frame,
    width,
    height,
    outputX,
    outputY,
    outputWidth,
    outputHeight,
    transform,
  });
  if (isCancelled()) throw new AffineResamplingCancelled();
  const output = new Float32Array(outputWidth * outputHeight * 3);
  const coverage = new Uint8Array(outputWidth * outputHeight);
  const inputBounds = sourceBounds({
    sourceWidth: width,
    sourceHeight: height,
    outputX,
    outputY,
    outputWidth,
    outputHeight,
    transform,
  });
  if (inputBounds === null) {
    return {x: outputX, y: outputY, width: outputWidth, height: outputHeight,
      interleavedRgb: output, coverage, inputBounds};
  }

  for (let localY = 0; localY < outputHeight; localY += 1) {
    if (isCancelled()) throw new AffineResamplingCancelled();
    const y = outputY + localY;
    for (let localX = 0; localX < outputWidth; localX += 1) {
      const x = outputX + localX;
      const sourceX = transform.m00 * x + transform.m01 * y + transform.m02;
      const sourceY = transform.m10 * x + transform.m11 * y + transform.m12;
      if (sourceX < 0 || sourceY < 0
          || sourceX > width - 1 || sourceY > height - 1) {
        continue;
      }
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fractionX = sourceX - x0;
      const fractionY = sourceY - y0;
      const weights = [
        (1 - fractionX) * (1 - fractionY),
        fractionX * (1 - fractionY),
        (1 - fractionX) * fractionY,
        fractionX * fractionY,
      ];
      const inputs = [
        (y0 * width + x0) * 3,
        (y0 * width + x1) * 3,
        (y1 * width + x0) * 3,
        (y1 * width + x1) * 3,
      ];
      const outputPixel = localY * outputWidth + localX;
      const outputBase = outputPixel * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        output[outputBase + channel] = inputs.reduce(
          (sum, input, index) => sum + frame[input + channel] * weights[index],
          0,
        );
      }
      coverage[outputPixel] = 1;
    }
  }
  return {x: outputX, y: outputY, width: outputWidth, height: outputHeight,
    interleavedRgb: output, coverage, inputBounds};
}

function sourceBounds({
  sourceWidth,
  sourceHeight,
  outputX,
  outputY,
  outputWidth,
  outputHeight,
  transform,
}) {
  const left = outputX;
  const top = outputY;
  const right = outputX + outputWidth - 1;
  const bottom = outputY + outputHeight - 1;
  const corners = [[left, top], [right, top], [left, bottom], [right, bottom]];
  const sourceXs = corners.map(([x, y]) =>
    transform.m00 * x + transform.m01 * y + transform.m02);
  const sourceYs = corners.map(([x, y]) =>
    transform.m10 * x + transform.m11 * y + transform.m12);
  assertFinite([...sourceXs, ...sourceYs], 'Transformed source coordinates');
  const minimumX = Math.min(...sourceXs);
  const maximumX = Math.max(...sourceXs);
  const minimumY = Math.min(...sourceYs);
  const maximumY = Math.max(...sourceYs);
  if (maximumX < 0 || maximumY < 0
      || minimumX > sourceWidth - 1 || minimumY > sourceHeight - 1) {
    return null;
  }
  const x = clamp(Math.floor(minimumX), 0, sourceWidth - 1);
  const y = clamp(Math.floor(minimumY), 0, sourceHeight - 1);
  const rightInclusive = clamp(Math.floor(maximumX) + 1, 0, sourceWidth - 1);
  const bottomInclusive = clamp(Math.floor(maximumY) + 1, 0, sourceHeight - 1);
  return Object.freeze({
    x,
    y,
    width: rightInclusive - x + 1,
    height: bottomInclusive - y + 1,
  });
}

function validateInput({
  frame,
  width,
  height,
  outputX,
  outputY,
  outputWidth,
  outputHeight,
  transform,
}) {
  if (!(frame instanceof Float32Array)
      || !Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0 || frame.length !== width * height * 3) {
    throw new Error('Invalid RGB frame dimensions.');
  }
  if (![outputX, outputY, outputWidth, outputHeight].every(Number.isInteger)
      || outputX < 0 || outputY < 0 || outputWidth <= 0 || outputHeight <= 0
      || outputX + outputWidth > width || outputY + outputHeight > height) {
    throw new Error('Invalid output tile.');
  }
  if (transform === null || typeof transform !== 'object') {
    throw new Error('A sampling transform is required.');
  }
  assertFinite(
    [transform.m00, transform.m01, transform.m02,
      transform.m10, transform.m11, transform.m12],
    'Affine coefficients',
  );
}

function assertFinite(values, label) {
  if (!values.every(Number.isFinite)) throw new Error(`${label} must be finite.`);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
