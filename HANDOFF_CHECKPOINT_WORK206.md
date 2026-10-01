# Work206 quality checkpoint

Baseline: Work205.

Implemented:
- Camera-profile construction no longer assumes RGGB before the CFA pattern is known.
- Initial profile validation now checks the D65 camera matrix with unit WB; the real pattern-specific WB transform is validated later when the actual CFA pattern is available.
- Multi-frame color consensus now preserves per-Green-phase white-balance asymmetry for frames sharing the same Bayer layout instead of collapsing both Green phases to one RGB median.
- If Bayer layouts differ, Green phase correspondence safely falls back to same-color averaging rather than inventing phase identity.

Quality rationale:
- Avoids rejecting/accepting a profile based on the wrong CFA color assignment.
- Preserves real per-phase Green calibration differences, reducing the risk of fixed-pattern chroma residuals being introduced by the consensus itself.
- Does not alter RAW values except through the already-existing WB harmonization path.

No changes:
- RAW decoder
- calibration
- registration/local registration
- CFA Drizzle accumulation
- robust combine
- gap fill
- demosaic algorithm
- Linear DNG writer
- tone/LUT/gamma

Verification:
- Node: 522/522 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan CTest: 8/8 PASS with libasan explicitly preloaded in this runtime.
- Flutter analyze/test, Android APK, Pixel real RAW, Adobe readback: NOT RUN here.
