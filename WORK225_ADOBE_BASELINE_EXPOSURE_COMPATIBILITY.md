# Work225 — Adobe BaselineExposure compatibility

STATUS=IMPLEMENTED_VALIDATION_IN_PROGRESS
DATE_JST=2026-08-25

## Real-reader failure

Adobe Photoshop COM 26.11.2 accepted the 4000x6000 real focus-stack DNG, but
its default rendering and exported PNG were all-white RGB 255. The file stored
Float32 samples inside the DNG linear-reference range, but also declared
BaselineExposure=+13 EV to invert the power-of-two placement.

## A/B diagnosis

A diagnostic copy changed only the BaselineExposure signed rational from 13/1
to 0/1. All 72,000,000 RGB samples, the mask, thumbnail, offsets, and file size
remained unchanged. Photoshop then rendered a normal non-white image of the
source scene. This isolates the defect to display-exposure metadata.

## Correction

The exporter continues using exact power-of-two placement so every positive
sample fits the Float LinearRaw 0..1 reference range and negative residuals are
preserved. It now writes neutral BaselineExposure=0 for final stack DNGs.
Upstream stack tiles can use calibrated raw-domain numeric units; converting
those units into the DNG reference range is normalization, not a request for an
equal Adobe display gain.

RAW decode, registration, focus scoring, marking, robust combination, gap fill,
demosaic, color-transform coefficients, and stored relative scene-linear pixel
relationships are unchanged.
