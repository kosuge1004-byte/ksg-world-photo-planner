export class RawCalibrationReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RawCalibrationReferenceError';
  }
}

function fail(message) {
  throw new RawCalibrationReferenceError(message);
}

function fourFiniteNumbers(values, {positive = false} = {}) {
  if (!Array.isArray(values) ||
      values.length !== 4 ||
      values.some((value) =>
        !Number.isFinite(value) ||
        (positive ? value <= 0 : value < 0))) {
    fail('RAW calibration metadata must contain four finite numbers');
  }
  return values;
}

function phaseIndex(x, y, originX = 0, originY = 0) {
  const phaseX = ((x - originX) % 2 + 2) % 2;
  const phaseY = ((y - originY) % 2 + 2) % 2;
  return phaseY * 2 + phaseX;
}

export function rawCalibrationParameters({
  blackLevels,
  whiteLevel,
  cameraWhiteBalance = null,
  blackLevelDeltaH = null,
  blackLevelDeltaV = null,
  width = null,
  height = null,
  activeLeft = 0,
  activeTop = 0,
}) {
  fourFiniteNumbers(blackLevels);
  if (!Number.isFinite(whiteLevel) || whiteLevel <= 0) {
    fail('RAW white level must be a finite positive number');
  }
  if (blackLevelDeltaH !== null &&
      (!Array.isArray(blackLevelDeltaH) ||
       !Number.isSafeInteger(width) || width <= 0 ||
       blackLevelDeltaH.length !== width ||
       blackLevelDeltaH.some((value) => !Number.isFinite(value)))) {
    fail('BlackLevelDeltaH must match the active width');
  }
  if (blackLevelDeltaV !== null &&
      (!Array.isArray(blackLevelDeltaV) ||
       !Number.isSafeInteger(height) || height <= 0 ||
       blackLevelDeltaV.length !== height ||
       blackLevelDeltaV.some((value) => !Number.isFinite(value)))) {
    fail('BlackLevelDeltaV must match the active height');
  }
  let maximumBlackLevel = Math.max(...blackLevels);
  if (blackLevelDeltaH !== null || blackLevelDeltaV !== null) {
    const scanWidth = width;
    const scanHeight = height;
    maximumBlackLevel = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < scanHeight; y++) {
      for (let x = 0; x < scanWidth; x++) {
        const phase = phaseIndex(x, y, activeLeft, activeTop);
        const computed = blackLevels[phase] +
            (blackLevelDeltaH?.[x] ?? 0) +
            (blackLevelDeltaV?.[y] ?? 0);
        maximumBlackLevel = Math.max(maximumBlackLevel, computed);
      }
    }
  }
  if (!Number.isFinite(maximumBlackLevel) || maximumBlackLevel >= whiteLevel) {
    fail('Every computed RAW black level must be below the white level');
  }
  const gains = cameraWhiteBalance === null ?
    [1, 1, 1, 1] :
    fourFiniteNumbers(cameraWhiteBalance, {positive: true});
  return {
    normalizationScale: 1 / (whiteLevel - maximumBlackLevel),
    gains: [...gains],
  };
}

export function calibrateRawSample({
  value,
  x,
  y,
  activeLeft = 0,
  activeTop = 0,
  blackLevels,
  whiteLevel,
  cameraWhiteBalance = null,
  linearizationTable = null,
  blackLevelDeltaH = null,
  blackLevelDeltaV = null,
  width = null,
  height = null,
}) {
  if (!Number.isFinite(value) ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !Number.isSafeInteger(activeLeft) ||
      !Number.isSafeInteger(activeTop)) {
    fail('RAW sample coordinates and value are invalid');
  }
  let linearizedValue = value;
  if (linearizationTable !== null) {
    if (!Array.isArray(linearizationTable) || linearizationTable.length === 0 ||
        linearizationTable.length > 65536 ||
        linearizationTable.some((entry) =>
          !Number.isSafeInteger(entry) || entry < 0 || entry > 65535) ||
        !Number.isSafeInteger(value) || value < 0) {
      fail('LinearizationTable or stored RAW value is invalid');
    }
    linearizedValue = linearizationTable[
      Math.min(value, linearizationTable.length - 1)];
  }
  const effectiveWidth = width ?? Math.max((blackLevelDeltaH?.length ?? 0), x + 1);
  const effectiveHeight = height ?? Math.max((blackLevelDeltaV?.length ?? 0), y + 1);
  const {normalizationScale, gains} = rawCalibrationParameters({
    blackLevels,
    whiteLevel,
    cameraWhiteBalance,
    blackLevelDeltaH,
    blackLevelDeltaV,
    width: effectiveWidth,
    height: effectiveHeight,
    activeLeft,
    activeTop,
  });
  const blackPhase = phaseIndex(x, y, activeLeft, activeTop);
  const cfaPhase = phaseIndex(x, y);
  const computedBlack = blackLevels[blackPhase] +
      (blackLevelDeltaH?.[x] ?? 0) +
      (blackLevelDeltaV?.[y] ?? 0);
  const normalized =
      (linearizedValue - computedBlack) * normalizationScale;
  // DNG 1.7.1 clips positive sensor values above linear reference white
  // after normalization, while allowing negative shadow residuals to survive
  // the early rendering stages. Camera white balance is applied afterwards,
  // so it may legitimately create values above 1.0 again.
  const clippedNormalized = Math.min(normalized, 1);
  const calibrated = clippedNormalized * gains[cfaPhase];
  if (!Number.isFinite(calibrated)) {
    fail('RAW calibrated sample is not finite');
  }
  return calibrated;
}

export function calibrateSamplePoints(points, metadata) {
  if (!Array.isArray(points)) fail('RAW sample points must be an array');
  return points.map(({x, y, value}) => ({
    x,
    y,
    value: calibrateRawSample({
      value,
      x,
      y,
      activeLeft: metadata.activeArea?.left ?? 0,
      activeTop: metadata.activeArea?.top ?? 0,
      blackLevels: metadata.blackLevels,
      whiteLevel: metadata.whiteLevel,
      cameraWhiteBalance: metadata.cameraWhiteBalance,
      linearizationTable: metadata.linearizationTable,
      blackLevelDeltaH: metadata.blackLevelDeltaH,
      blackLevelDeltaV: metadata.blackLevelDeltaV,
      width: metadata.activeArea?.width,
      height: metadata.activeArea?.height,
    }),
  }));
}
