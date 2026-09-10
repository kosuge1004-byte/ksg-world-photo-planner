# Direct download precision-distance fix — 2026-09-09

The surrounding-data download previously ignored the precision setting and always generated bearing profiles using the absolute 50 km ceiling.

Fixed:
- App passes `precisionSettings.tripodSearchMaxDistanceMeters` into `backfillBearingProfiles()`.
- The manager clamps that value to the existing absolute safety bounds.
- Distance generation now uses the requested precision-setting range. Default is therefore 10 km.
- Existing cached profiles are reused only when their stored distance coverage reaches the newly requested range; a prior 50 km profile remains valid for 10 km, while a 10 km profile is not mistaken for a complete 50 km profile.
- DEM source priority, 1 m high-precision sampling, bearing interval and final verification are unchanged.
