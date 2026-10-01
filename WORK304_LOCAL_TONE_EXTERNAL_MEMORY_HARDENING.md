# Work304 — Local Tone Adaptation external-memory hardening

## Confirmed Work303 bottleneck
`tiled_local_tone_adaptation.dart` still kept three full-image Float64 planes:
luminance, surround and gain.

At 60 MP:
- one Float64 plane = ~480 MB decimal
- three simultaneous planes = ~1.44 GB decimal

This is allocation arithmetic from the source structure, not measured Android RSS.

## Work304 change
The production tiled local-tone implementation now:
1. reads RGB strips;
2. computes luminance and the exact horizontal box blur, writing Float64 rows to disk;
3. computes the exact vertical box blur from haloed row reads, writing surround rows to disk;
4. computes the same interpolated percentile using external chunk sort + k-way merge;
5. computes gain on demand per RGB output tile and never creates a full-image gain plane.

The full-image Float64 planes are therefore no longer resident in Dart heap.

## Quality invariants
- same luminance dot product and non-negative luminance clamp;
- same separable edge-clamped box blur;
- same percentile definition: sorted ranks + linear interpolation;
- same gain equation and min/max clamp;
- same Float32 RGB output behavior.

A whole-frame-vs-streamed exact parity test was added, but cannot be executed
here because Dart/Flutter SDK is unavailable.

## Validation performed here
- static source/wiring checks;
- native tree unchanged from Work303;
- ZIP CRC test.
