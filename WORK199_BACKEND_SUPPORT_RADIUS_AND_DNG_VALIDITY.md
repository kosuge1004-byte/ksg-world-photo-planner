# Work199 - Backend support radius and Linear DNG validity boundary

## Summary
Work199 corrects a Work198 assumption and hardens the Linear DNG validity boundary without changing RAW decode, calibration, registration, CFA Drizzle accumulation, robust combine, demosaic mathematics, or color mathematics.

## 1. Work198 correction: production Native demosaic radius is 4
Work198 changed `MobileStackAdaptiveDemosaicEngine.requiredInputRadius` from 4 to 5 after tracing the Dart mathematical reference implementation. That radius is correct for the Dart reference implementation, but the highest-quality production path does not use that reference implementation: `DemosaicRegistry.requireProduction()` selects `NativeMobileStackDemosaicEngine`.

The Native C contract explicitly declares:

`MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS = 4`

and the Native regression test asserts the same value. The C implementation's documented dependency chain is also radius 4.

Using the Dart-reference radius 5 for a Native-produced image therefore expanded saturation/undefined influence by one unnecessary pixel. Work199 separates these contracts:

- Dart adaptive reference: `referenceRequiredInputRadius = 5`
- Native production backend: `nativeRequiredInputRadius = 4`
- Reference bilinear backend: radius 1
- `DemosaicEngine` now exposes `requiredInputRadius`

The Phase2 saturation influence mask and CFA-Drizzle Linear-DNG validity mask now use the radius reported by the engine actually selected for processing.

This is deliberately not a heuristic. It removes a mismatch between the backend that creates the RGB pixels and the backend support used to classify those pixels as valid/invalid.

## 2. Linear DNG transparency mask is enforced as binary validity data
The app's transparency mask contract is binary source validity:

- 0 = invalid / undefined
- 255 = source-supported / valid

The writer previously checked mask dimensions but accepted intermediate alpha values 1..254. Work199 rejects those values at the Linear DNG writer boundary. This prevents future callers from silently changing source validity into partial-opacity semantics.

## Validation executed in this environment
- Node tests: 514/514 PASS
- Native clean Release CTest: 8/8 PASS
- Native ABI exports: 10 PASS
- Native ASan/UBSan CTest: 8/8 PASS

## Not executed
This environment still has no Flutter/Dart SDK or adb, so the following remain NOT RUN:
- flutter pub get / analyze / test
- Android APK build
- Pixel real-device RAW test
- Adobe Lightroom / Camera Raw readback

## Quality-impact statement
This work does not change demosaic equations or reconstruction values. It changes only the support-radius contract used to decide which already-generated RGB pixels are considered influenced by invalid/saturated CFA input, and hardens the binary transparency-mask writer contract.
