# Work160 Quality Batch — DNG RAW Linearization and Black-Level Model

## Scope
This batch completes the DNG stored-RAW to linear-reference path that can be represented by the current 2x2 CFA calibration contract. The goal is correctness before demosaic, not subjective rendering changes.

## Implemented
1. **LinearizationTable (tag 50712)**
   - Native DNG parser reads and owns the table.
   - ABI v1 is extended only at the tail; existing field offsets are preserved.
   - Dart metadata/probe carries an immutable copy.
   - Calibration applies the table before black subtraction.
   - Stored values outside the table index range map to the last table entry.

2. **BlackLevelDeltaH / BlackLevelDeltaV (tags 50715 / 50716)**
   - Native parser validates counts against ActiveArea width/height.
   - FFI and Dart metadata carry both arrays.
   - Orientation normalization swaps/reverses H/V arrays so they remain aligned with the decoder's normalized mosaic.
   - Per-pixel black subtraction uses `BlackLevel + DeltaH[x] + DeltaV[y]`.

3. **Maximum computed black level normalization**
   - WhiteLevel scaling uses the maximum computed black level across the sample plane, including H/V deltas.
   - The exact maximum is computed by 2x2 CFA parity in O(width + height), not by scanning every pixel.
   - Native metadata is rejected before the ABI boundary if maximum computed black is not below WhiteLevel.

4. **Correct clipping order**
   - Processing order is Linearization -> Black subtraction -> WhiteLevel rescaling -> upper clip.
   - Values above normalized 1.0 are clipped at the sensor-normalization boundary.
   - Negative shadow residuals are retained for later noise/statistical processing.
   - Camera white balance remains after this boundary and may create values above 1.0 again.

5. **Saturation mask alignment with LinearizationTable**
   - If a LinearizationTable is present, the sensor saturation mask is rebuilt immediately after linearization using WhiteLevel.
   - It is still fixed before black subtraction, white normalization, WB, flat-field correction, or demosaic.

6. **BlackLevelRepeatDim safety**
   - Current internal calibration stores a four-phase 2x2 black pattern.
   - 1x1, 1x2, 2x1, and 2x2 repeat dimensions remain exactly representable.
   - Larger valid repeat dimensions are rejected rather than silently collapsed into an incorrect 2x2 approximation.

7. **Metadata integrity and ownership**
   - Linearization/delta arrays are deep-copied and released on all native ownership paths.
   - RawFrameMetadata validates DeltaH/DeltaV lengths against ActiveArea dimensions.
   - Native parser resource/error cleanup was hardened while adding dynamic arrays.

## Verification performed in this environment
- Native C/CMake clean build: PASS.
- Native CTest: 8/8 PASS.
- Native fixtures cover LinearizationTable, DeltaH/V ABI delivery, invalid computed-black rejection, and unsupported BlackLevelRepeatDim rejection.
- Node reference/regression tests: 368/368 PASS.
- Dart regression tests were added for LinearizationTable, H/V deltas, orientation-normalized metadata merge, metadata length validation, and post-linearization saturation-mask rebuilding.

## Not claimed
Flutter/Dart SDK is unavailable in this environment. Therefore no `flutter test`, `dart analyze`, APK build, or device validation is claimed for this Work160 WIP.

## Deliberately not guessed
This batch does not reinterpret unsupported DNG calibration patterns into a lower-dimensional approximation. A future full BlackLevelRepeatDim implementation would need to carry arbitrary repeat dimensions through the metadata/ABI/pixel pipeline instead of pretending they are 2x2.
