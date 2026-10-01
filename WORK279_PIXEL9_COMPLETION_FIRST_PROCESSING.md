# Work279: Pixel 9 completion-first highest-quality processing

Version: `0.8.15+170`

## Change

- For CFA drizzle stacks with 8 or more registered frames, process one 64 px
  output tile at a time with one worker isolate.
- Do not dispatch the next tile until the current tile has been written.
- Yield for 8 ms between tiles to reduce sustained CPU load and heat.
- Keep the same CFA drizzle, robust rejection, weighting, registration,
  supersampling, and Linear DNG calculations. The new path changes throughput,
  not pixel values.
- Stacks below 8 frames retain up to two workers.

## Verification

- `flutter analyze`: no issues.
- `flutter test`: 857 tests passed.
- Added direct pixel-equality coverage comparing the one-worker cooldown path
  with the existing streamed and four-worker paths.
- Android arm64 release APK built successfully (22.1 MB).
- Pixel virtual-device testing was intentionally omitted for this delivery per
  the user's latest instruction.

## Main changed files

- `lib/core/drizzle/parallel_robust_cfa_drizzle.dart`
- `lib/core/session/cfa_drizzle_milky_way_pipeline.dart`
- `test/tiled_robust_combine_cfa_drizzle_test.dart`
- `pubspec.yaml`

