# Work293 calibration in-place memory hardening

- Baseline: Work292.
- Verified before change: black-level, white-level normalization and camera WB already mutate the owned RAW Float32 plane in place.
- Remaining light-frame full-plane allocations were dark subtraction and flat-field correction.
- Added pipeline-only in-place variants while retaining the existing public non-mutating reference functions and tests.
- Invalid masks are constructed directly as packed 1-bit-per-pixel storage; the hot path no longer allocates Uint8List(pixelCount) merely to convert it to a packed mask.
- Phase2 correction stages now use the in-place variants.
- Numerical formulas, finite checks, minimum flat threshold, invalid-mask semantics, CFA, precision and all downstream image-quality algorithms are unchanged.
- Expected avoided transient Float32 allocation: one full RAW plane per dark stage and one full RAW plane per flat stage (not simultaneously in the normal sequential pipeline). At 33 MP: ~132 MB per avoided allocation; at 60 MP: ~240 MB. Actual RSS reduction must be measured on device.
- Added exact-equivalence tests for sample values, masks, and sample-buffer identity.
- Flutter/Dart SDK availability determines whether those Dart tests can be executed in this environment.
