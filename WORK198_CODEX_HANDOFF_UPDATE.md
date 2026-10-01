# Work198 Codex handoff update

Use Work198 as the newest baseline instead of Work197 or earlier.

Before any real-device comparison, preserve the Work198 adaptive-demosaic support contract:
- `MobileStackAdaptiveDemosaicEngine.requiredInputRadius == 5`.
- CFA-Drizzle missing/saturation validity expansion must use that same constant.
- Do not reduce the radius back to 4 merely to save overlap/mask area.

Run the existing Codex-first Flutter/Android checks against Work198. Any change to RAW decode, calibration, registration, CFA Drizzle, robust combine, demosaic mathematics, or Linear DNG writing must be separately justified by measured quality evidence.
