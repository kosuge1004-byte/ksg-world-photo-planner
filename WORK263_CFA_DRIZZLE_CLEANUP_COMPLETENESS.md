# Work263 — CFA Drizzle cleanup completeness

## Scope
Static ownership/lifecycle audit continuing Work261/Work262. No image-processing mathematics, registration thresholds, rejection parameters, color transforms, or export pixel semantics were changed.

## Finding
The robust CFA Drizzle branch still had sequential `dispose()` loops for per-frame value/coverage/saturation stores and for decoded raw mosaic stores. If any single `dispose()` threw, Dart would leave the loop immediately and later temporary stores would not be released. The inner combined-store cleanup had the same early-exit property.

This was a residual lifecycle gap after the earlier cleanup hardening. It is relevant to Android temporary-file/resource leakage, especially after an I/O failure during teardown.

## Change
`cfa_drizzle_milky_way_pipeline.dart` now uses best-effort cleanup helpers that:

- attempt every owned store even if an earlier `dispose()` fails;
- avoid double-disposing duplicate store references;
- retain and rethrow the first cleanup exception after all cleanup attempts;
- cover inner combined/pre-rejection stores, all per-frame RGB stores, and all temporary raw mosaic stores.

No successful-path ownership transfer was changed.

## Verification status
Static source checks: performed.
Flutter/Dart tests: NOT RUN — SDK unavailable in this environment.
Flutter analyze: NOT RUN.
Android APK build: NOT RUN.
Sony α7 III real ARW: NOT VERIFIED.
