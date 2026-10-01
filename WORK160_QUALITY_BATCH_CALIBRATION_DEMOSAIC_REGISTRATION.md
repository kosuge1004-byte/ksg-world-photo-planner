# Work160 Quality Batch — calibration / demosaic / registration

Status: WIP. Flutter/Dart SDK tests and application builds are still pending.

This batch intentionally groups related quality-first changes rather than
creating one ZIP per small edit.

## 1. Calibration-frame RAW domain parity

Master dark and master flat preparation now uses the same pre-normalization DNG
sensor-domain steps as light frames:

1. optional `LinearizationTable`
2. computed black subtraction using `BlackLevel` + `BlackLevelDeltaH/V`
3. optional dark subtraction for flats
4. median master combine / flat normalization

`prepareMasterDark` and `prepareMasterFlat` now accept a `RawMetadataProbe` and
all production session pipelines pass their configured metadata probe into
calibration-frame preparation. This closes the gap where light frames used the
new Work160 linearization/spatial-black metadata while calibration frames still
used only the legacy four-value repeated black level.

White-level normalization and camera white balance remain intentionally after
dark subtraction in the light path; they are not baked into the master dark.

## 2. Quality-first registration defaults

High-level Milky Way registration/export now defaults to bicubic Catmull-Rom
resampling instead of bilinear. The existing project reference test already
quantifies the synthetic Gaussian-star FWHM widening at the worst half-pixel
offset as about 103% for bicubic versus about 107% for bilinear.

The low-level `TiledAffineRgbResampler` retains its bilinear default for API
compatibility, while quality-path entry points and `TiledRegisteredRgbStacker`
default to bicubic.

## 3. Native adaptive demosaic precision

The adaptive chroma weight in `mobile_stack_demosaic.c` now evaluates its
non-linear power in double precision (`pow`) instead of first quantizing the
base and exponent to FP32 for `powf`. This matches the Dart mathematical
reference more closely and follows the quality policy's `allowApproximateMath
== false`. Final public RGB tiles remain FP32.

## Verification available in this environment

- clean native C/CMake build: PASS
- native CTest: 8/8 PASS
- Node reference/regression tests: 42 files, 368/368 PASS
- Flutter/Dart tests: NOT RUN (SDK unavailable)
- APK/application build: NOT RUN

Version remains `0.8.5+159`; Work160 is not promoted to a completed release.
