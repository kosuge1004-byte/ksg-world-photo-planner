# Work288 — sustained CPU-load hardening

Basis: Work287 memory hardening.

## Change
- Native adaptive demosaic worker count reduced from fixed 4 threads to fixed 2 threads.
- Full-frame RAW jobs were already serialized by `fullFrameRawConcurrencyPolicy(maximumWorkers: 1)`, so this targets the remaining inner parallelism that could keep four CPU cores busy for long periods.

## Expected effect
- Lower peak and sustained CPU occupancy during demosaic.
- Lower thermal pressure and power draw, at the cost of longer demosaic wall-clock time.
- Work287's removal of one redundant full-frame Float32 copy also reduces memory-bandwidth CPU work.

## Quality contract
Demosaic equations, cache logic, interpolation, Float precision, tile geometry, output order, and all stack/calibration algorithms are unchanged. Only independent output-row scheduling is reduced from four worker threads to two.

## Deliberately not changed
- No image-quality shortcuts.
- No reduced resolution.
- No 8-bit conversion.
- No weaker rejection/stack parameters.
- No arbitrary sleeps inserted into pixel loops.

## Validation
Host native C/C++ build and ctest should be run. Flutter/Dart SDK is unavailable in this environment, so Flutter analyze/test cannot be run here.
