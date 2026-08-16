# AR Camera Phase 5 - Celestial tracks

Implemented:
- AR camera renders Sun, Moon, and Milky Way center at the selected AstroSight date/time.
- Uses the shared `calculateCelestialHorizontalCoordinates()` path, so AR does not introduce a separate astronomy calculation.
- Draws each enabled body's daily trajectory in Cesium AR space.
- Draws an hourly point on each visible trajectory; labels follow the main-screen convention and appear every two hours to avoid excessive overlap.
- The selected-time body marker updates with the main timeline slider.
- AR celestial visibility uses the same `CelestialVisibility` state as the main screen; disabling a body removes its marker, track, and hourly points together.
- Observer position is the live AR GPS location. A lens/eye-height offset of 1.6 m is used for the observer elevation.
- Below-horizon portions are not rendered; trajectory segments are split across hidden portions rather than drawing through the ground.

Not part of Phase 5:
- ARCore/ARKit visual-inertial correction.
- Search integration using a frozen AR current position (Phase 6).
- Native iPhone camera intrinsics bridge.
