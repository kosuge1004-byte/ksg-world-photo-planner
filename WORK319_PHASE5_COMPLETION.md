# Work319 Phase 5/5 — completion hardening

Implemented on top of Work318.

- Predictive, quality-neutral memory admission before large RAW/post-decode/export work.
- Explicit processor memory budget using physical RAM, current available RAM and processor RSS.
- RSS growth tracking and safe-boundary processor heap recycling when a durable checkpoint exists.
- Dedicated maintenance-restart marker so planned heap reclamation does not consume the bounded failure-retry budget.
- Supervisor/ProcessorService support for maintenance-only processor recycling.
- Decoded source stores are released as soon as the combined checkpoint no longer needs them, before final encoder allocations.
- Existing two-generation post-decode checkpoint and export receipt remain authoritative for recovery.
- Fixed a pre-existing duplicate named `contributionStore` argument in `registerAndCombineDecodedFramesAndExport` found during the final pass.

Validation available in this environment:
- `node tool/verify_work319_completion_contract.mjs`: 25/25 PASS.
- `node tool/focus_reference_coverage_memory_contract.test.mjs`: PASS.
- `node tool/verify_work301_streamed_raw_calibration.mjs`: PASS.
- ZIP CRC/integrity: checked after packaging.

Not available in this environment:
- Flutter/Dart compilation.
- Android Gradle/APK build.
- Physical-device/ANR/OOM recovery verification.

No image-quality setting is reduced by this phase.
