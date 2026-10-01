# Work194 — Reference viability quality safeguard

## Goal
Keep the highest intrinsic-quality reference-frame policy from Work182/192, but avoid failing an otherwise viable stack merely because the top intrinsic-quality candidate cannot register enough frames.

## Confirmed issue in Work193
Both normal Milky Way and CFA Drizzle paths ranked candidates by the validated intrinsic star-quality score, selected exactly one reference, and only then attempted registration. If that one reference produced fewer than `minRegisteredFrames`, the whole stack failed. A lower-ranked but still high-quality candidate was never tried, even if it could register enough frames.

## Work194 behavior
For both Milky Way and CFA Drizzle:
1. Rank candidates by the existing intrinsic quality score.
2. Preserve the existing star-count tie-break and deterministic index tie-break.
3. Starting from the best candidate, run the same similarity-transform estimator against other detected-star sets only as a viability probe.
4. Select the first intrinsic-quality-ranked candidate that can satisfy `minRegisteredFrames` including itself.
5. Run the normal registration/combine path unchanged using that selected reference.

This does not invent a new image-quality score. If the top intrinsic-quality reference is viable, downstream behavior is unchanged. The fallback only prevents an otherwise viable multi-frame stack from being discarded.

## Drizzle gap-fill audit
The gap-fill algorithm itself was not changed because no real-RAW A/B evidence is available in this environment to prove that a different interpolation rule would always improve image quality.

A quality-safety invariant was verified instead: for Linear DNG export, synthesized gap-filled pixels do not become falsely classified as directly source-supported. Both RGB and reconstructed-CFA DNG transparency masks are built from the original drizzle `coverageStore`, not from the gap-filled output.

## Validation
- Node complete suite: 506/506 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 verified.
- ASan/UBSan CTest: 8/8 PASS.
- Mechanical Work193→Work194 source diff before documentation: only
  - `lib/core/session/milky_way_pipeline.dart`
  - `lib/core/session/cfa_drizzle_milky_way_pipeline.dart`
  - new `tool/quality/reference_viability_quality.test.mjs`
- No changes to RAW decode, calibration, demosaic, CFA accumulation, robust pixel combine, gap-fill math, reconstruction math, or Linear DNG writer.

## Still pending for Codex / real device
- `flutter pub get`
- `flutter analyze`
- `flutter test`
- Android arm64 APK build
- Pixel process-death/background tests
- Real RAW A/B evaluation
- Adobe Lightroom / Camera Raw DNG read validation
