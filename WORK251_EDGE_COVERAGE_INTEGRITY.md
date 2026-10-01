# Work251 — Stellar-edge coverage integrity audit/fix

## Scope
Continued deep audit of the Milky Way stack path after Work250, focusing on transform direction, inverse resampling coverage, dual sky/foreground alignment, rejection stacking contribution semantics, and Linear DNG validity propagation.

## Confirmed issue
`AdaptiveDualAlignmentResampler.sampleTile()` previously replaced any star-aligned sample whose inverse transform landed outside the source frame with the same-coordinate identity sample, provided that exact identity pixel was not masked.

That fallback is not geometrically valid for sky pixels. At a shifted/rotated frame boundary there is no registered source observation for the requested output coordinate. Substituting the unwarped identity pixel can therefore inject unregistered sky into an otherwise star-aligned stack and can produce duplicated/trailed stars or discontinuities near transformed image borders.

This issue is not camera-specific. It is common to every input routed through Milky Way mode with `preserveStaticForeground=true` (the default) whenever a non-identity stellar transform creates an uncovered edge.

## Fix
Changed the dual-alignment boundary behavior to fail closed:

- If the stellar candidate has zero coverage, keep the output sample uncovered.
- Do not synthesize coverage from the identity candidate in that case.
- Continue to choose identity alignment for static foreground only where both a valid stellar candidate and identity candidate exist and can be compared to the reference.
- Downstream contribution counts and the Linear DNG transparency mask now truthfully represent the missing registered observation at transform boundaries.

No interpolation, registration thresholds, frame weights, kappa-sigma parameters, RAW decoding, demosaic, WB/color conversion, or DNG color metadata were changed.

## Regression test
Added a test proving that when a +1px source offset maps the last output column outside the source, the dual-alignment result leaves that column uncovered and zero-filled rather than copying the unregistered identity pixel.

## Additional audit results
- Similarity-transform estimator output direction is consistent with `AffineSamplingTransform.similarity`: reference/output -> target/source inverse sampling.
- Affine source bounds are derived from the four transformed output-tile corners; this is sufficient for an affine transform because extrema over a rectangle occur at corners.
- Bicubic support uses a 4x4 Catmull-Rom footprint and expands the source read region by one pixel. No interior tile-seam support gap was found in static inspection.
- Kappa-sigma contribution counts are maintained per RGB channel and the Linear DNG validity mask requires all three channels to have at least one surviving observation. No mismatch was found in this path.
- Linear DNG export receives the contribution store and derives invalid output pixels from post-rejection observations rather than RGB brightness.

## Verification status
Static source verification: PASS for the specific Work251 change.
Flutter/Dart tests: NOT RUN (SDK unavailable in this environment).
Flutter analyze: NOT RUN.
Android release APK build: NOT RUN.
Sony α7 III real-RAW validation: NOT VERIFIED in this environment.
