# Work224 Codex final-focus memory bounding

## Scope and invariant

This continuation addresses the real 6000x4000 Sony ARW Dart-heap failures in
focus analysis and final stacking. It changes storage, ownership, and buffer
lifetime only. Demosaic quality, alignment model/interpolation, focus radii,
winner comparisons, confidence formulas, regularization thresholds, blend
weights, Float32 rounding, and Linear-DNG color/output contracts are unchanged.

## 24 MP memory changes

| Stage | Previous full-resolution heap state | Current state |
|---|---:|---:|
| Orientation/ActiveArea normalization | second 96 MB Float32 RAW plane | decoder-owned plane transformed in place; two bitsets |
| Focus measure | about 288 MB Float64+Int32 integral transient per measure | integral rows and planes file-backed; final scores file-backed |
| Selected focus measures | about 96 MB per selected frame | 65,536-pixel chunks across Float32 score files |
| Aligned RGB | about 288 MB RGB + 24 MB coverage per frame | one registered RGB tile per frame plus final output |
| Blend weights | about 96 MB per two selected frames | one Float32 weight per frame, reused per pixel |
| Regularization neighbors | List and objects per low-confidence pixel | one reused typed label/weight buffer |
| Regularization maps | input + first pass + second pass, about 576 MB | two owned alternating pairs, about 384 MB |
| Completed result winner map | about 192 MB, unused by UI/export | not retained |
| Review aligned luminance | about 96 MB per frame retained | reference + current frame; score written immediately |

The final RGB output itself remains full-resolution Float32 camera RGB (about
288 MB at 6000x4000) and its binary coverage remains full-resolution. No
resolution reduction, quality fallback, or silent frame-count cap was added.

## Equivalence evidence

- In-place RAW orientation: all 8 TIFF orientations pass exact mapping and
  shared-buffer checks.
- File-backed modified Laplacian: radii 0/1/2/4 match the in-memory path bit
  exactly.
- Allocation-free regularizer: 200 randomized maps match the old List sort;
  owned two-pair reuse matches the preserving path on another 200 maps.
- Fused per-pixel blend: 100 randomized blends match materialized Float32
  weights bit exactly.
- Tiled registered RGB blend matches the old full-frame path for identity and
  for scale+rotation+sub-pixel translation; a 10-frame identity case also
  matches bit exactly.
- File-backed winner selection and adjacent-order refinement match the
  in-memory five-frame path bit exactly.
- Direct Dart static analysis: no issues.
- Node source/reference contracts: 609/609 pass.
- Existing Windows native CTest artifacts: 8/8 pass.
- Synthetic focus-result Linear DNG export writes a valid classic TIFF/DNG,
  preserves a negative stored sample, places headroom below stored 1.0 with
  BaselineExposure=7 EV, and reconstructs a maximum greater than 1. This is not
  a substitute for the pending real-ARW and Adobe readback.

## Required validation still not run

- The twelfth AVD run was last observed still analyzing at about 377 MiB PSS,
  with no Dart OOM or fatal exception. AVD inspection then became unavailable
  because the Codex usage limit rejected ADB execution.
- A fresh APK containing the later final-stack memory changes is not built or
  installed. Flutter tool execution requires SDK lockfile write permission,
  which is currently unavailable under the same usage-limit block.
- The newly added Flutter regressions are not claimed PASS. The most recent
  full Flutter result before these changes was 791/791 PASS.
- Physical Android device, real Linear DNG save/readback, Adobe readback, and
  5/10+ real full-resolution frame runs remain NOT RUN.
- Desktop handoff copy is blocked. Checkpoint61 is the latest successful
  Desktop artifact; newer ZIPs continue under the Codex `outputs` directory at
  a maximum ten-minute cadence.
