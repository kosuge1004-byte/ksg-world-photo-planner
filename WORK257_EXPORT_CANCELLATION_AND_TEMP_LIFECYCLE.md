# Work257 - Export cancellation and temporary-result lifecycle audit

## Scope
Work256 was used as the baseline. This batch intentionally leaves RAW decode, demosaic, registration, local residual correction, resampling, kappa-sigma, white balance, color transforms, and DNG pixel encoding unchanged.

## Fix 1: Linear DNG contribution-mask construction now honors cancellation
`buildLinearDngTransparencyMask()` previously scanned the full contribution store without accepting the pipeline cancellation callback. On a full-frame 6048x4024 stack this stage can touch more than 24 million output pixels after stacking has already completed. A user cancellation during this scan therefore could not take effect until the mask was completely built.

Work257 threads `isCancelled` from `exportTileStoreToImage()` into the validity-mask builder and checks cancellation before each read block plus periodically during a large block. Cancellation raises a dedicated `LinearDngValidityBuildCancelled` control-flow exception and is handled by the existing export failure/cancellation boundary.

No validity semantics were weakened: a pixel is still valid only when all RGB channels retain at least one surviving contribution.

## Fix 2: Result-route failure no longer leaks an owned temp directory
`ProcessingProgressScreen` set `resultHandedToScreen = true` before `Navigator.push`. If route construction/navigation itself threw, the `finally` block treated the result as already handed off and skipped cleanup of `mobile-stack-result-*`.

Work257 sets the ownership-transfer flag only after `Navigator.push` succeeds. Normal successful result-screen behavior is unchanged; `ResultScreen` still owns and removes the temporary result on disposal.

## Quality invariants retained
- no changes to RAW decoding
- no changes to demosaic
- no changes to PSF/star detection
- no changes to Similarity/local residual registration
- no changes to bicubic sampling
- no changes to Work252 small-stack robust rejection
- no changes to kappa or iteration count
- no changes to Linear DNG color transform/headroom/pixel precision
- no fallback to lower-quality output

## Verification status
Static source checks: PASS
Dart/Flutter tests: NOT RUN (SDK unavailable in this environment)
Flutter analyze: NOT RUN
Android APK build: NOT RUN
Sony α7 III real RAW: NOT VERIFIED
