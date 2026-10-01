# Work195 Codex handoff update

Use Work195 as the newest baseline, superseding Work194 for future Codex work.

Preserve Work195's direct-RGB saturation-validity rule. In particular, do not simplify the Linear DNG transparency decision back to survivor coverage only. When saturation coverage exists, the RGB path must use saturation coverage and, in the robust path, pre-rejection non-saturated decision coverage for the saturation-fraction denominator.

All previously pending Flutter/Android/device items remain pending. Run the existing Work187 Codex preflight/device procedures against this Work195 tree, then audit logs and diffs before any further quality changes.

Do not change gap-fill interpolation, outputScale policy, native demosaic, or DNG writer merely to make a test pass. Real-RAW A/B evidence is required before choosing outputScale=2 versus outputScale=1+real-demosaic as the final quality winner.
