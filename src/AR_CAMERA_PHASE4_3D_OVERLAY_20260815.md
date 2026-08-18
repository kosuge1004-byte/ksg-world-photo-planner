# AR Camera Phase 4 - 3D overlay / subject pin

Implemented on top of Phase 3.

- Added a dedicated Cesium overlay inside the full-screen AR camera.
- Live GPS position drives the Cesium observer position.
- Live compass heading and device beta/gamma drive heading/pitch/roll.
- Android Camera2-derived FOV from Phase 2 is applied to the Cesium perspective frustum when safely available.
- Standard AR 3D display uses GSI imagery + PLATEAU terrain + PLATEAU buildings.
- Cesium sky/background is transparent so the live camera remains visible behind the 3D layer.
- Added 3D opacity slider (0-85%, default 42%).
- Existing subject point is rendered as an AR subject pin. AR still starts without a subject point.
- Cesium camera input is disabled; the AR camera is driven only by device tracking.
- Camera/3D/status controls remain above the 3D overlay.

Notes:
- Phase 4 intentionally uses the sensor-based camera pose. ARCore/ARKit visual-inertial correction is not yet connected.
- The AR search path is still intentionally blocked until the current GPS position is frozen as the search tripod position in the later integration phase.
- Full `npm run build` cannot complete in this workspace because the supplied `node_modules/geo-tz/index.js` is missing before TypeScript starts. Modified TS/TSX files pass TypeScript parser/transpile syntax diagnostics.
