# Work220 checkpoint
Baseline: Work219.

Implemented:
- Added review model carrying exact per-frame focus mask, marked fraction, omission-candidate state and user-selected state.
- Added full focus-marking review screen.
- RAW embedded thumbnail is displayed when available.
- High-precision focus mask is drawn as a semi-transparent overlay with a CustomPainter.
- Overlay can be toggled on/off for visual comparison.
- Horizontal frame strip allows switching among all selected RAWs.
- Each frame has a user-controlled "使用する" checkbox.
- At least two frames are enforced.
- Omission candidates are visibly badged when the user enables that option.
- Auto-excluded frames remain visible and can be re-enabled.
- A review navigation boundary is added to FocusStackScreen.
- Work220 does not yet run the high-precision analyzer from the button; it establishes the exact review/render/selection UI contract for Work221.

Verification:
- Node: 573/573 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
