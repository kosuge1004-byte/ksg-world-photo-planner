# Project screen import / QR UI fix — 2026-08-20

## Confirmed root cause
`ProjectsScreen` uses `z-index: 260`, while `.project-dialog-backdrop` used `z-index: 120`.
Therefore both the QR scanner and shared-project import confirmation dialog opened behind the project screen.
This made "コードを読み取る" look as if it did not open and made "取り込む" look unresponsive even though the handlers fired.

## Changes
- Raised project dialog backdrop to z-index 420 so dialogs render above the project screen.
- Reworked import area into a wide responsive panel.
- Changed QR action label to horizontal `コードを読み取る` and prevented vertical wrapping.
- On phone portrait, text/code field spans full width and `取り込む` / `コードを読み取る` are two horizontal buttons below it.
- Changed QR camera viewport from portrait 3:4 to wide 4:3.
- Kept image-file QR decoding mode.
- Import action is disabled only while the input is empty and supports Ctrl/Cmd+Enter.
- Project card action layout was tightened to resemble the approved mockup while retaining all existing actions.

## Regression conditions
1. Open プロジェクト.
2. Tap コードを読み取る: QR dialog must appear above the project screen and camera video must be visible.
3. Close QR dialog: project screen remains usable.
4. Paste a valid share URL/code and tap 取り込む: shared-project confirmation dialog must appear above the project screen.
5. Cancel/complete import: return to project screen normally.
