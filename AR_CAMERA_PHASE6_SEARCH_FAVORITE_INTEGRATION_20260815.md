# AR Camera Phase 6 - Search / Favorite / Integration

Implemented on 2026-08-15.

- AR transit search now requires a subject only when the search button is pressed.
- Search uses a frozen snapshot of the AR GPS location as the tripod position. GPS updates after pressing search do not move the search origin.
- If AR camera FOV is safely available, its horizontal FOV is converted to a full-frame-equivalent focal length for the existing in-frame search engine. The AR FOV aspect ratio is also forwarded to the existing search dialog. Raw smartphone focal length is intentionally not reused because that would mismatch the app's full-frame camera model.
- Normal (non-AR) transit search explicitly clears all AR search overrides before opening.
- AR favorite/project save uses the current AR location as the saved tripod position without mutating the main-screen tripod pin.
- AR project save requires a subject and a valid current location; AR itself still starts and renders without a subject.
- Cancel/save clears temporary AR project-save overrides.
- Transit-search close clears temporary AR search overrides.
- AR camera projection is now published to App so search can use the live camera FOV.
- Transit-search and project-save dialog z-indexes were raised above the full-screen AR shell.
- Existing shared celestial visibility, date/time, subject, and project infrastructure remain shared rather than duplicated.

Build note: `npm run build` cannot proceed in this extracted archive because `node_modules/geo-tz/index.js` is absent before TypeScript compilation begins. No successful full build is claimed.
