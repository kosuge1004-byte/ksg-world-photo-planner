# CODEX_FOCUS_STACK_FINAL_VERIFICATION

Use Work224 as the baseline. Do not change image-quality algorithms unless a failing test or real-image artifact demonstrates the need.

## Mandatory build checks
- flutter pub get
- flutter analyze
- flutter test
- build Android arm64 release APK
- install and launch on a physical Android device

## Mandatory UI flow
1. Open 深度合成.
2. Select at least 2 RAWs.
3. Verify invalid mixed dimensions/CFA/ActiveArea/orientation are rejected.
4. Run 合焦位置を解析.
5. Verify exact-coordinate central preview + mask alignment.
6. Verify 省略可能な写真を表示.
7. Verify 省略可能な写真を自動除外.
8. Re-enable an auto-excluded frame.
9. Manually disable/enable frames.
10. Confirm selected frames only are stacked.
11. Save Linear DNG.

## Mandatory marking tests
Use at least:
- flat target + sharp object
- fine foliage
- macro subject
- thin wires/hair
- specular highlights
- low-texture fog/sky
- portrait-orientation RAWs

Reject release if the marking is visibly offset from actual focus.

## Mandatory output checks
- DNG opens in Lightroom / Camera Raw / Photoshop.
- Dimensions are correct.
- No unexpected clipping or gamma bake.
- Color is stable across focus boundaries.
- Transparency mask does not create visible border artifacts.
- Compare against source RAW and Photoshop stack at 100% / 200%.

## Memory checks
Use 2, 5, 10+ full-resolution RAWs where device storage permits.
Confirm no silent quality downgrade, no resolution reduction, and no low-quality fallback.

If a real test fails, preserve the failing input and report the exact stage, exception/log,
device model, Android/iOS version, RAW format, image dimensions and frame count.
