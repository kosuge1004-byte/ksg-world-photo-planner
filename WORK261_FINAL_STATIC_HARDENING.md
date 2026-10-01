# Work261 — Final static hardening batch

This batch continues from Work260 and targets remaining resource/cancellation gaps found by a final cross-path source audit.

## Changes

1. CFA drizzle robust-rejection coverage summation is now cancellable. `_sumCoverageStores` can scan every tile across every per-frame coverage store; it now checks cancellation before each output tile and before each input-store read, and both production call sites forward `isCancelled`.
2. CFA drizzle export cleanup now attempts disposal of every owned temporary RGB store even if an earlier `dispose()` fails. Duplicate store references are disposed only once. This prevents one cleanup failure from stranding later file-backed temporary stores.
3. BMP partial-output cleanup is now protected by nested `try/finally`: a close/flush failure cannot skip deletion of an incomplete output file.

## Deliberately unchanged

No RAW decode, calibration, demosaic, PSF centroid, registration transform, local residual correction, resampling, robust rejection thresholds, frame weighting, color transform, tone curve, DNG numeric semantics, JPEG quality, or TIFF precision was changed.

## Verification boundary

Static source checks only in this environment. Flutter/Dart tests, analyzer, Android release build, and real Sony α7 III ARW A/B validation remain required release gates.
