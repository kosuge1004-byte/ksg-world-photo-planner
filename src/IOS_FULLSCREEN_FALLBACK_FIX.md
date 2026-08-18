# iPhone fullscreen fallback fix

- Added a shared fullscreen controller for preview and map sections.
- Uses the standard Fullscreen API on supported browsers such as Android Chrome.
- Falls back to a fixed-position in-app fullscreen mode when iPhone Safari rejects or does not expose element fullscreen.
- Added safe-area-aware exit controls and map control placement.
- Locks page scrolling while fallback fullscreen is active.
- Exiting fullscreen clears both native and fallback states.
