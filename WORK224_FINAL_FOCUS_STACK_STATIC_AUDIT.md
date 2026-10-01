# WORK224_FINAL_FOCUS_STACK_STATIC_AUDIT

## Scope
Final static audit of the focus-stack feature added in Work210..223.

## Verified architecture
1. Input/UI
   - dedicated 深度合成 home entry
   - RAW structural compatibility validation
   - explicit user ordering
   - optional omission-candidate display
   - optional auto-exclusion with user override
   - minimum two selected frames enforced

2. Precision-critical focus marking
   - coverage-aware multi-scale Modified Laplacian at support radii 1/2/4
   - robust lower-half positive-response normalization
   - median multi-scale fusion to reject one-scale spikes
   - confidence thresholding + real overlap retention
   - marking review uses an exact-coordinate preview generated from the aligned analysis luminance
   - embedded JPEG orientation is no longer relied on for the central precision-critical overlay

3. Registration / focus breathing
   - general-scene Shi-Tomasi features
   - ZNCC mutual-best matching
   - robust scaled-similarity fit
   - one-pass bicubic inverse sampling for scale + rotation + translation
   - coverage propagated through resampling

4. Focus-map and blend
   - winner + confidence
   - ordinal regularization
   - high-confidence anchors preserved
   - adjacent focus-order refinement only
   - halo-aware secondary weighting
   - final linear RGB accumulation with Float64 temporaries

5. RAW -> DNG path
   - production RAW decoder
   - production demosaic required
   - no focus-stack bilinear/downsample/FP16/approximate fallback found
   - linear camera RGB retained through blend
   - selected RAW ColorMatrix compatibility is required, never averaged
   - reference WB/ColorMatrix applied once at Linear DNG serialization
   - coverage exported as binary DNG transparency mask
   - DNG save UI connected

## Work224 correction
A precision risk was found in Work223:
the central review overlay used an embedded JPEG preview without a proven preview-orientation contract.
Work224 replaces that central review image with a display-only preview generated directly
from the aligned analysis luminance coordinate system. Therefore mask and displayed review
image share the same geometry independent of embedded JPEG EXIF/orientation behavior.

Small strip thumbnails may still use embedded JPEGs because they are navigation aids only;
no precision marking overlay is interpreted from those thumbnails.

## Static verification
- Node tests: 592/592 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10 PASS
- ASan/UBSan: 8/8 PASS

## Still requires Codex / Flutter / device evidence
- flutter pub get
- flutter analyze
- flutter test
- Android arm64 APK build/install
- iOS build if applicable
- real RAW focus-bracket sets, including portrait/rotated RAWs
- visual overlay correctness on-device
- large-image memory pressure / process death
- final Linear DNG open in Adobe Camera Raw / Lightroom / Photoshop
- image-quality A/B against Photoshop focus stacking on controlled test sets
- halo, thin-detail, foliage, translucent subject, low-texture and macro cases

No claim of real-device or Adobe validation is made by Work224.
