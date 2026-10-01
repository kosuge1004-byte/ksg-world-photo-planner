# Work222 checkpoint
Baseline: Work221.

Implemented:
- Focus-stack result now carries the reference CFA pattern needed to interpret reference-frame WB.
- Every selected RAW must provide D65 camera color matrix and camera white-balance metadata.
- Selected RAW camera color matrices must agree within 1e-5; matrices are never averaged or guessed.
- WB is not applied per frame before blending. The stack stays in linear camera RGB through focus alignment/blending.
- One reference-frame RawCameraColorProfile is applied exactly once during Linear-DNG serialization.
- Existing exportTileStoreToLinearDng() converts camera RGB -> white-balanced scene-linear sRGB/D65 and preserves highlight headroom via the established BaselineExposure contract.
- Focus-stack coverage is exported as a binary DNG transparency mask.
- No gamma, tone curve, sharpening, or per-frame color-temperature seam is introduced by the focus-stack export path.
- UI path selection / save button is not connected yet.

Verification:
- Node: 583/583 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN in this environment.
