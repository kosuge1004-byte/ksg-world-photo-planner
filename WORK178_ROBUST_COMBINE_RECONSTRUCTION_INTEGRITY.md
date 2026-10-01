# Work178 — Robust CFA combine / native reconstruction integrity

Status: WIP.

## Audit
The robust CFA combine already has strong numeric guards:
- finite/non-negative per-frame coverage;
- finite sample values;
- finite positive sigma thresholds;
- median + MAD robust center/spread;
- finite weighted sums and outputs;
- tiled Float32 range checks.

No rejection threshold was retuned.

## Confirmed reconstruction hardening
The non-tiled native-CFA reconstruction wrote Float64 drizzle values directly
into Float32 storage without an explicit representability check. It now rejects
a reconstructed sample outside finite Float32 range before downcast.

The tiled reconstruction now validates every read:
- value must be finite;
- coverage must be finite and non-negative;
- saturation coverage must be finite and non-negative.

This prevents corrupted backing-store state from entering gap fill, saturation
classification or the final LinearRawMosaic.

## Quality decision
No change to median/MAD rejection, sigmaLow=4, sigmaHigh=3, pixfrac, or gap-fill
parameters. Those alter real image content and require image-level evidence.

STScI Drizzle documentation confirms that overlap-area weighting is the core
Drizzle model and that pixfrac/scale tuning is dataset dependent rather than
having one universal optimum.

## Executed validation
- Node/reference/source-contract suite: 71/71 passed.
- Native clean CMake configure/build passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
