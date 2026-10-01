const RED = 0;
const GREEN = 1;
const BLUE = 2;

export class DemosaicCancelled extends Error {
  constructor() {
    super('Demosaic processing was cancelled.');
    this.name = 'DemosaicCancelled';
  }
}

export function cfaColorAt(pattern, x, y) {
  const evenX = (x & 1) === 0;
  const evenY = (y & 1) === 0;
  switch (pattern) {
    case 'rggb':
      return evenX && evenY ? RED : !evenX && !evenY ? BLUE : GREEN;
    case 'bggr':
      return evenX && evenY ? BLUE : !evenX && !evenY ? RED : GREEN;
    case 'grbg':
      return !evenX && evenY ? RED : evenX && !evenY ? BLUE : GREEN;
    case 'gbrg':
      return evenX && !evenY ? RED : !evenX && evenY ? BLUE : GREEN;
    default:
      throw new Error(`Unsupported CFA pattern: ${pattern}`);
  }
}

// Creates a fresh set of memoization maps for a single demosaic call. The
// cache is local to one `demosaicAdaptiveTile` (or `analyzeLocalStructure`)
// invocation and is discarded afterwards, so it never grows unbounded and
// never leaks state between tiles, frames, or images. Every cached function
// remains a pure function of (source, x, y[, target]); the cache only avoids
// recomputing a value that a previous pixel in the same tile already derived
// from identical inputs, so no output value changes.
function createDemosaicCache() {
  return {
    proxy: new Map(),
    structure: new Map(),
    green: new Map(),
    colorDifference: new Map(),
  };
}

function cacheKey2(x, y) {
  return `${x},${y}`;
}

function cacheKey3(x, y, target) {
  return `${x},${y},${target}`;
}

export function demosaicAdaptiveTile({
  width,
  height,
  cfaPattern,
  samples,
  tile = {
    outputX: 0,
    outputY: 0,
    outputWidth: width,
    outputHeight: height,
  },
  isCancelled = () => false,
}) {
  validateInput(width, height, samples, tile);
  const output = new Float32Array(tile.outputWidth * tile.outputHeight * 3);
  const source = { width, height, cfaPattern, samples };
  const cache = createDemosaicCache();

  for (let localY = 0; localY < tile.outputHeight; localY += 1) {
    if (isCancelled()) throw new DemosaicCancelled();
    const y = tile.outputY + localY;
    for (let localX = 0; localX < tile.outputWidth; localX += 1) {
      const x = tile.outputX + localX;
      const nativeColor = cfaColorAt(cfaPattern, x, y);
      const green = greenAt(source, x, y, cache);
      const red = nativeColor === RED
        ? sampleAt(source, x, y)
        : green + suppressedColorDifference(source, x, y, RED, cache);
      const blue = nativeColor === BLUE
        ? sampleAt(source, x, y)
        : green + suppressedColorDifference(source, x, y, BLUE, cache);
      const maxFloat32 = 3.4028234663852886e38;
      if (![red, green, blue].every(Number.isFinite)
          || Math.abs(red) > maxFloat32
          || Math.abs(green) > maxFloat32
          || Math.abs(blue) > maxFloat32) {
        throw new Error(
          'Adaptive demosaic produced a non-finite or Float32-overflow RGB sample.',
        );
      }
      const base = (localY * tile.outputWidth + localX) * 3;
      output[base] = red;
      output[base + 1] = green;
      output[base + 2] = blue;
    }
  }
  return {
    x: tile.outputX,
    y: tile.outputY,
    width: tile.outputWidth,
    height: tile.outputHeight,
    interleavedRgb: output,
  };
}

function greenAt(source, x, y, cache) {
  if (cfaColorAt(source.cfaPattern, x, y) === GREEN) {
    return sampleAt(source, x, y);
  }
  if (cache) {
    const key = cacheKey2(x, y);
    const cached = cache.green.get(key);
    if (cached !== undefined) return cached;
    const value = computeGreenAt(source, x, y, cache);
    cache.green.set(key, value);
    return value;
  }
  return computeGreenAt(source, x, y, cache);
}

function computeGreenAt(source, x, y, cache) {
  const center = sampleAt(source, x, y);
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
  ];
  const estimates = [];
  const residuals = [];
  for (const [dx, dy] of directions) {
    const adjacentGreen = mirroredSample(source, x + dx, y + dy);
    const sameColor = mirroredSample(source, x + 2 * dx, y + 2 * dy);
    estimates.push(adjacentGreen + 0.5 * (center - sameColor));
    residuals.push(
      Math.abs(center - sameColor)
        + Math.abs(luminanceProxy(source, x, y, cache)
          - luminanceProxy(source, x + dx, y + dy, cache)),
    );
  }

  // The four quadrant candidates are deliberately built from independently
  // corrected one-sided estimates. They let a diagonal edge select the two
  // green samples on its tangent without recursively demosaicing a diagonal
  // red/blue site.
  const quadrantPairs = [[0, 2], [1, 2], [0, 3], [1, 3]];
  const candidateValues = [...estimates];
  const candidateResiduals = [...residuals];
  for (const [first, second] of quadrantPairs) {
    candidateValues.push((estimates[first] + estimates[second]) * 0.5);
    candidateResiduals.push((residuals[first] + residuals[second]) * 0.5);
  }

  const structure = localStructure(source, x, y, cache);
  const directionVectors = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-Math.SQRT1_2, -Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, Math.SQRT1_2],
  ];
  let weighted = 0;
  let totalWeight = 0;
  for (let index = 0; index < candidateValues.length; index += 1) {
    const [dx, dy] = directionVectors[index];
    const directionalEnergy = Math.max(0,
      dx * dx * structure.xx
        + 2 * dx * dy * structure.xy
        + dy * dy * structure.yy);
    const cost = candidateResiduals[index]
      + directionalEnergy * (0.5 + 1.5 * structure.coherence);
    const weight = 1 / (1e-8 + cost * cost);
    weighted += candidateValues[index] * weight;
    totalWeight += weight;
  }
  const advanced = weighted / totalWeight;
  const horizontal = (estimates[0] + estimates[1]) * 0.5;
  const vertical = (estimates[2] + estimates[3]) * 0.5;
  const horizontalGradient =
    Math.abs(mirroredSample(source, x - 1, y)
      - mirroredSample(source, x + 1, y))
      + Math.abs(2 * center
        - mirroredSample(source, x - 2, y)
        - mirroredSample(source, x + 2, y));
  const verticalGradient =
    Math.abs(mirroredSample(source, x, y - 1)
      - mirroredSample(source, x, y + 1))
      + Math.abs(2 * center
        - mirroredSample(source, x, y - 2)
        - mirroredSample(source, x, y + 2));
  const horizontalWeight = 1
    / (1e-6 + horizontalGradient * horizontalGradient);
  const verticalWeight = 1
    / (1e-6 + verticalGradient * verticalGradient);
  const legacy = (horizontal * horizontalWeight + vertical * verticalWeight)
    / (horizontalWeight + verticalWeight);

  // Direction signs distinguish a single edge from oscillating texture:
  // a structure tensor alone assigns high coherence to both. Bimodality then
  // reserves the aggressive multi-direction estimate for locally two-level
  // transitions; smooth ramps, stars, and periodic detail stay conservative.
  const blend = smoothStep(0.72, 0.94, structure.coherence)
    * smoothStep(0.18, 0.55, structure.directedCoherence)
    * smoothStep(0.04, 0.1, Math.sqrt(structure.energy))
    * smoothStep(0.32, 0.72, structure.bimodality);
  return legacy + (advanced - legacy) * blend;
}

function luminanceProxy(source, x, y, cache) {
  if (cache) {
    const key = cacheKey2(x, y);
    const cached = cache.proxy.get(key);
    if (cached !== undefined) return cached;
    const value = computeLuminanceProxy(source, x, y);
    cache.proxy.set(key, value);
    return value;
  }
  return computeLuminanceProxy(source, x, y);
}

function computeLuminanceProxy(source, x, y) {
  const sampleX = mirror(x, source.width);
  const sampleY = mirror(y, source.height);
  if (cfaColorAt(source.cfaPattern, sampleX, sampleY) === GREEN) {
    return sampleAt(source, sampleX, sampleY);
  }
  return (
    mirroredSample(source, sampleX - 1, sampleY)
      + mirroredSample(source, sampleX + 1, sampleY)
      + mirroredSample(source, sampleX, sampleY - 1)
      + mirroredSample(source, sampleX, sampleY + 1)
  ) * 0.25;
}

function localStructure(source, x, y, cache) {
  if (cache) {
    const key = cacheKey2(x, y);
    const cached = cache.structure.get(key);
    if (cached !== undefined) return cached;
    const value = computeLocalStructure(source, x, y, cache);
    cache.structure.set(key, value);
    return value;
  }
  return computeLocalStructure(source, x, y, cache);
}

function computeLocalStructure(source, x, y, cache) {
  let xx = 0;
  let yy = 0;
  let xy = 0;
  let meanX = 0;
  let meanY = 0;
  let localMin = Number.POSITIVE_INFINITY;
  let localMax = Number.NEGATIVE_INFINITY;
  const proxies = [];
  for (let windowY = -1; windowY <= 1; windowY += 1) {
    for (let windowX = -1; windowX <= 1; windowX += 1) {
      const sampleX = x + windowX;
      const sampleY = y + windowY;
      const proxy = luminanceProxy(source, sampleX, sampleY, cache);
      proxies.push(proxy);
      localMin = Math.min(localMin, proxy);
      localMax = Math.max(localMax, proxy);
      const gx = 0.5 * (luminanceProxy(source, sampleX + 1, sampleY, cache)
        - luminanceProxy(source, sampleX - 1, sampleY, cache));
      const gy = 0.5 * (luminanceProxy(source, sampleX, sampleY + 1, cache)
        - luminanceProxy(source, sampleX, sampleY - 1, cache));
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
      meanX += gx;
      meanY += gy;
    }
  }
  xx /= 9;
  yy /= 9;
  xy /= 9;
  meanX /= 9;
  meanY /= 9;
  const trace = xx + yy;
  const anisotropy = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy);
  const range = localMax - localMin;
  let twoLevelResidual = 0;
  if (range > 1e-12) {
    for (const proxy of proxies) {
      twoLevelResidual += Math.min(proxy - localMin, localMax - proxy);
    }
    twoLevelResidual /= proxies.length * range;
  }
  return {
    xx,
    yy,
    xy,
    energy: trace,
    coherence: anisotropy / (trace + 1e-12),
    directedCoherence: (meanX * meanX + meanY * meanY)
      / (trace + 1e-12),
    bimodality: range <= 1e-12
      ? 0
      : Math.max(0, 1 - twoLevelResidual / 0.22),
  };
}

function smoothStep(lower, upper, value) {
  const normalized = Math.max(0, Math.min(1,
    (value - lower) / (upper - lower)));
  return normalized * normalized * (3 - 2 * normalized);
}

export function analyzeLocalStructure(source, x, y) {
  return localStructure(source, x, y);
}

function rawColorDifference(source, x, y, target, cache) {
  if (cache) {
    const key = cacheKey3(x, y, target);
    const cached = cache.colorDifference.get(key);
    if (cached !== undefined) return cached;
    const value = computeRawColorDifference(source, x, y, target, cache);
    cache.colorDifference.set(key, value);
    return value;
  }
  return computeRawColorDifference(source, x, y, target, cache);
}

function computeRawColorDifference(source, x, y, target, cache) {
  const cardinal = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const diagonal = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const nativeColor = cfaColorAt(source.cfaPattern, x, y);
  if (nativeColor === target) {
    return sampleAt(source, x, y) - greenAt(source, x, y, cache);
  }
  const offsets = nativeColor === GREEN ? cardinal : diagonal;
  const used = new Set();
  let weightedDifference = 0;
  let totalWeight = 0;
  const centerGreen = greenAt(source, x, y, cache);
  const structure = localStructure(source, x, y, cache);
  const rootEnergy = Math.sqrt(structure.energy);
  const edgeAdaptation = smoothStep(0.7, 0.95, structure.coherence)
    * smoothStep(0.025, 0.09, rootEnergy)
    * smoothStep(0.18, 0.55, structure.directedCoherence)
    * smoothStep(0.32, 0.72, structure.bimodality);
  const textureAdaptation = (1 - structure.coherence)
    * smoothStep(0.02, 0.08, rootEnergy);

  for (const [dx, dy] of offsets) {
    const sampleX = mirror(x + dx, source.width);
    const sampleY = mirror(y + dy, source.height);
    const key = sampleY * source.width + sampleX;
    if (used.has(key)
        || cfaColorAt(source.cfaPattern, sampleX, sampleY) !== target) {
      continue;
    }
    used.add(key);
    const neighborGreen = greenAt(source, sampleX, sampleY, cache);
    const difference = sampleAt(source, sampleX, sampleY) - neighborGreen;
    const length = Math.hypot(dx, dy);
    const unitX = dx / length;
    const unitY = dy / length;
    const directionalEnergy = Math.max(0,
      unitX * unitX * structure.xx
        + 2 * unitX * unitY * structure.xy
        + unitY * unitY * structure.yy);
    const cost = Math.abs(centerGreen - neighborGreen)
      + 0.5 * edgeAdaptation * Math.sqrt(directionalEnergy);
    const exponent = 1 + 0.45 * edgeAdaptation
      - 0.2 * textureAdaptation;
    const weight = 1 / Math.pow(1e-6 + cost, exponent);
    weightedDifference += difference * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedDifference / totalWeight;
}

function suppressedColorDifference(source, x, y, target, cache) {
  const neighborhood = [];
  let localMin = Number.POSITIVE_INFINITY;
  let localMax = Number.NEGATIVE_INFINITY;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const sampleX = mirror(x + dx, source.width);
      const sampleY = mirror(y + dy, source.height);
      const value = rawColorDifference(source, sampleX, sampleY, target, cache);
      neighborhood.push(value);
      localMin = Math.min(localMin, value);
      localMax = Math.max(localMax, value);
    }
  }
  const center = neighborhood[4];
  if (localMax - localMin > 0.15) return center;
  neighborhood.sort((a, b) => a - b);
  return neighborhood[4];
}

function mirroredSample(source, x, y) {
  return sampleAt(source, mirror(x, source.width), mirror(y, source.height));
}

function sampleAt(source, x, y) {
  return source.samples[y * source.width + x];
}

function mirror(coordinate, length) {
  if (length <= 1) return 0;
  const period = 2 * (length - 1);
  let value = coordinate % period;
  if (value < 0) value += period;
  return value < length ? value : period - value;
}

function validateInput(width, height, samples, tile) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0 || samples.length !== width * height) {
    throw new Error('Invalid CFA dimensions or sample count.');
  }
  if ([...samples].some((value) => !Number.isFinite(value))) {
    throw new Error('Adaptive demosaic input contains a non-finite CFA sample.');
  }
  if (!Number.isInteger(tile.outputX) || !Number.isInteger(tile.outputY)
      || !Number.isInteger(tile.outputWidth)
      || !Number.isInteger(tile.outputHeight)
      || tile.outputX < 0 || tile.outputY < 0
      || tile.outputWidth <= 0 || tile.outputHeight <= 0
      || tile.outputX + tile.outputWidth > width
      || tile.outputY + tile.outputHeight > height) {
    throw new Error('Invalid output tile.');
  }
}
