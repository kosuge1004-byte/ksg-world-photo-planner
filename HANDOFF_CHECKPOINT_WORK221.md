# Work221 checkpoint
Baseline: Work220.

Implemented:
- Repaired Work220 UI corruption where the review helper had been duplicated into multiple widget classes.
- Added a real pre-composite marking-analysis pipeline:
  RAW decode -> production demosaic -> scaled-similarity alignment -> high-precision multi-scale focus marking.
- The valid-input bottom button now starts the real focus analysis.
- Analysis progress is displayed without ETA.
- The marking result is converted to the review model and opened in the review screen.
- Review overlay projection now uses the same BoxFit.contain destination rectangle as the RAW preview, preventing letterbox/pillarbox marking offsets.
- User-confirmed selectedInputs alone are passed to runFocusStackPipeline().
- Auto-excluded frames remain reviewable and can be re-enabled before confirmation.
- A completed focus-stack result is retained in memory and reported as Linear camera RGB; Linear DNG export remains pending.

Verification:
- Node: 578/578 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN in this environment.
