# Work262 — General TileStore cleanup hardening

## Finding
The normal Milky Way and star-trail pipelines disposed decoded frame stores with simple sequential loops. If one `dispose()` threw, the loop stopped and later stores were never offered cleanup. This is particularly undesirable for file-backed stores after cancellation, decode failure, combine failure, or export failure.

## Change
- Milky Way decoded-frame cleanup now attempts every unique non-null store, remembers the first cleanup exception, and rethrows it only after all stores have been attempted.
- Star-trail decode-failure cleanup and post-combine cleanup use the same all-stores-attempted semantics.
- Duplicate store references are disposed once.
- No image arithmetic, registration, rejection, weighting, color, or export semantics changed.

## Verification available here
Static source checks only. Flutter/Dart SDK is not installed in this environment, so `flutter test`, `flutter analyze`, APK build, and real α7 III ARW validation were not run.
