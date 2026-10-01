# Work240 - Normal ARW failure diagnostics and preflight correction

Date: 2026-08-25
Baseline: Work239

## Why this work was necessary
A real-device screenshot showed 45/45 jobs failed while the UI highlighted
"入力ファイルを確認".

Static inspection proved that highlight was not reliable evidence of the true
failure stage. `_StageRow` was derived only from aggregate progress thresholds.
When every failed job retained progress 0, the first row was automatically shown
as active regardless of where the exception actually occurred.

The scheduler already retained each job's `sourcePath`, `currentStageLabel` and
`error`, but ProcessingProgressScreen discarded those details and collapsed the
result to "N件のジョブが失敗しました。".

Therefore the exact historical 45-file root cause cannot be recovered from that
screenshot alone.

## Corrections

### 1. Normal ARW selection now uses the production native metadata probe
`RawSelectionScreen` changed from:
- `createFeatureFlaggedNativeRawMetadataProbe()`

to:
- `createProductionNativeRawMetadataProbe()`

The old feature-flagged probe supports DNG metadata only, so ARW selection was
accepted mainly from generic TIFF/header validation without the production ARW
native metadata preflight.

The new path validates supported ARW structure through the production native
metadata backend before files are admitted to a normal processing session.

### 2. Processing recheck uses the same production ARW probe
`ProcessingProgressScreen` now also uses
`createProductionNativeRawMetadataProbe()`, keeping selection-time and
processing-time validation aligned.

### 3. Actual failure details are shown
When jobs fail the screen now shows, for up to five failures:
- filename,
- actual pipeline stage when available,
- exact stored exception text.

If an exception occurs before a pipeline stage is entered, the stage is reported
as `RAWファイル検証／ネイティブデコード` instead of pretending that the
first visual stage is known.

The session error also records the first file/stage/error, rather than only the
failure count.

### 4. Misleading stage display removed on failure
On a failed session the pseudo four-step progress rows are replaced by an
explicit red `処理停止` summary using the actual failed-job stage.

## What is and is not proven
PROVEN from source:
- the old 0%-progress UI could mislabel the failure as "入力ファイルを確認";
- exact per-job exceptions existed but were hidden;
- normal ARW selection used the DNG-only feature-flagged metadata probe;
- Work240 corrects all three issues.

NOT PROVEN without one of the user's failing ARW files or a Work240 rerun:
- the historical 45/45 failure was specifically an unsupported Sony compression
  layout, native file-open failure, decoder error, demosaic error, or another
  exception.

Work240 is designed so the next run exposes that exact cause instead of hiding it.

## Quality contract
No RAW pixel decoding algorithm, calibration coefficient, demosaic algorithm,
registration algorithm, stack algorithm, focus algorithm, color transform,
DNG normalization, or BaselineExposure=0 EV was changed.

## Verification
- Node: 657/657 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10/10 PASS.
- Flutter analyze/test/APK: NOT RUN here because Flutter/Dart SDK is unavailable.
- Physical-device 45-file rerun: NOT RUN here.
