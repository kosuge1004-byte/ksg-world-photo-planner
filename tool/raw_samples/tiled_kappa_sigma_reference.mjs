export class TiledStackingCancelled extends Error {
  constructor() {
    super('Tiled rejection stacking was cancelled.');
    this.name = 'TiledStackingCancelled';
  }
}

/// Numerical reference for the per-band Dart rejection equations.
/// Frames are small in-memory fixtures here; production Dart re-reads one
/// covered affine band at a time so its memory does not grow with frame count.
export function combineCoveredRgb({
  frames,
  frameWeights,
  kappa = 2.5,
  maximumIterations = 3,
  minimumSurvivingFrames = 1,
  isCancelled = () => false,
}) {
  validate({
    frames,
    frameWeights,
    kappa,
    maximumIterations,
    minimumSurvivingFrames,
  });
  if (isCancelled()) throw new TiledStackingCancelled();
  const maximumWeight = Math.max(...frameWeights);
  const weights = frameWeights.map((weight) => weight / maximumWeight);
  if (weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('Frame-weight dynamic range is too large.');
  }
  const sampleCount = frames[0].rgb.length;
  const meansHistory = [];
  const thresholdsHistory = [];
  const enabledHistory = [];

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const sums = new Float64Array(sampleCount);
    const weightSums = new Float64Array(sampleCount);
    const survivorCounts = new Uint32Array(sampleCount);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      if (isCancelled()) throw new TiledStackingCancelled();
      forEachCoveredSample(frames[frameIndex], (sample, index) => {
        if (!survives(sample, index, meansHistory,
          thresholdsHistory, enabledHistory)) return;
        sums[index] += sample * weights[frameIndex];
        weightSums[index] += weights[frameIndex];
        survivorCounts[index] += 1;
      });
    }
    const means = new Float64Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      if (weightSums[index] > 0) means[index] = sums[index] / weightSums[index];
    }

    const varianceSums = new Float64Array(sampleCount);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      if (isCancelled()) throw new TiledStackingCancelled();
      forEachCoveredSample(frames[frameIndex], (sample, index) => {
        if (!survives(sample, index, meansHistory,
          thresholdsHistory, enabledHistory)) return;
        const difference = sample - means[index];
        varianceSums[index] += difference * difference * weights[frameIndex];
      });
    }

    const thresholds = new Float64Array(sampleCount);
    const eligible = new Uint8Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      if (survivorCounts[index] <= minimumSurvivingFrames
          || weightSums[index] <= 0) continue;
      const variance = varianceSums[index] / weightSums[index];
      if (!Number.isFinite(variance) || variance < 0) {
        throw new Error('Stack variance is invalid.');
      }
      const threshold = kappa * Math.sqrt(variance);
      if (Number.isFinite(threshold) && threshold > 1e-12) {
        thresholds[index] = threshold;
        eligible[index] = 1;
      }
    }

    const candidates = new Uint32Array(sampleCount);
    for (const frame of frames) {
      if (isCancelled()) throw new TiledStackingCancelled();
      forEachCoveredSample(frame, (sample, index) => {
        if (eligible[index] === 0) return;
        if (survives(sample, index, meansHistory,
          thresholdsHistory, enabledHistory)
            && Math.abs(sample - means[index]) <= thresholds[index]) {
          candidates[index] += 1;
        }
      });
    }
    const enabled = new Uint8Array(sampleCount);
    let rejectedAny = false;
    for (let index = 0; index < sampleCount; index += 1) {
      if (eligible[index] !== 0
          && candidates[index] >= minimumSurvivingFrames
          && candidates[index] < survivorCounts[index]) {
        enabled[index] = 1;
        rejectedAny = true;
      }
    }
    meansHistory.push(means);
    thresholdsHistory.push(thresholds);
    enabledHistory.push(enabled);
    if (!rejectedAny) break;
  }

  const sums = new Float64Array(sampleCount);
  const weightSums = new Float64Array(sampleCount);
  const contributions = new Uint16Array(sampleCount);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    if (isCancelled()) throw new TiledStackingCancelled();
    forEachCoveredSample(frames[frameIndex], (sample, index) => {
      if (!survives(sample, index, meansHistory,
        thresholdsHistory, enabledHistory)) return;
      sums[index] += sample * weights[frameIndex];
      weightSums[index] += weights[frameIndex];
      contributions[index] += 1;
    });
  }
  const rgb = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    if (weightSums[index] === 0) continue;
    const value = sums[index] / weightSums[index];
    if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) {
      throw new Error('Stack output is outside finite FP32 range.');
    }
    rgb[index] = value;
  }
  return {rgb, contributions};
}

function forEachCoveredSample(frame, callback) {
  for (let pixel = 0; pixel < frame.coverage.length; pixel += 1) {
    if (frame.coverage[pixel] === 0) continue;
    const base = pixel * 3;
    callback(frame.rgb[base], base);
    callback(frame.rgb[base + 1], base + 1);
    callback(frame.rgb[base + 2], base + 2);
  }
}

function survives(sample, index, means, thresholds, enabled) {
  for (let iteration = 0; iteration < means.length; iteration += 1) {
    if (enabled[iteration][index] !== 0
        && Math.abs(sample - means[iteration][index])
          > thresholds[iteration][index]) return false;
  }
  return true;
}

function validate({
  frames,
  frameWeights,
  kappa,
  maximumIterations,
  minimumSurvivingFrames,
}) {
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 65535) {
    throw new Error('One to 65535 frames are required.');
  }
  const sampleCount = frames[0]?.rgb?.length;
  if (!Number.isInteger(sampleCount) || sampleCount <= 0 || sampleCount % 3) {
    throw new Error('Invalid RGB sample count.');
  }
  for (const frame of frames) {
    if (!(frame.rgb instanceof Float32Array)
        || !(frame.coverage instanceof Uint8Array)
        || frame.rgb.length !== sampleCount
        || frame.coverage.length * 3 !== sampleCount
        || [...frame.rgb].some((value) => !Number.isFinite(value))
        || [...frame.coverage].some((value) => value !== 0 && value !== 1)) {
      throw new Error('Invalid covered RGB frame.');
    }
  }
  if (!Array.isArray(frameWeights) || frameWeights.length !== frames.length
      || frameWeights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('Invalid frame weights.');
  }
  if (!Number.isFinite(kappa) || kappa <= 0
      || !Number.isInteger(maximumIterations) || maximumIterations <= 0
      || !Number.isInteger(minimumSurvivingFrames)
      || minimumSurvivingFrames <= 0) {
    throw new Error('Invalid clipping configuration.');
  }
}
