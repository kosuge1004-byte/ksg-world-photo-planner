# Work162 — Contribution-derived DNG validity mask foundation

Status: WIP.

## Implemented
- Converts the exact post-kappa-sigma RGB survivor counts preserved in Work161
  into a one-byte-per-pixel validity mask.
- 255 means R, G and B all have at least one surviving observation.
- 0 means one or more output color planes have no surviving observation.
- Validity is never inferred from output brightness; valid linear black remains
  valid image data.
- Adds a summary contract for valid/invalid output-pixel counts.

## DNG specification audit
- TIFF/DNG transparency-mask IFDs use NewSubFileType = 4 and
  PhotometricInterpretation = 4.
- Adobe's DNG SDK accepts transparency masks as a distinct image role.
- The mask is not yet embedded into the Linear DNG in this Work item.
  Embedding requires updating both classic TIFF and BigTIFF IFD layout and
  offsets atomically; that is intentionally deferred rather than emitting a
  structurally questionable DNG.

## Validation
- Node/reference suite executed after the change.
- Native CMake/CTest executed after the change.
- Dedicated exact RGB-contribution validity tests added.
- Production Dart source-contract test added.
- Flutter/Dart SDK unavailable, so Dart analyze/tests/APK remain unexecuted.
