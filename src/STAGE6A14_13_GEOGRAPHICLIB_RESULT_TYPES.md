# Stage 6A-14-13 GeographicLib result type hardening

## Scope

No runtime calculation was changed.

The local TypeScript declaration for `geographiclib-geodesic` now marks the fields returned by `Geodesic.STANDARD` as required:

- inverse result: `s12`, `azi1`, `azi2`
- direct result: `s12`

## Reason

All current calls explicitly request `Geodesic.STANDARD`. These fields are therefore part of the expected result contract. Keeping them optional forced the runtime adapter to carry unnecessary uncertainty and could hide an incorrect mask or declaration change.

## Audit result

No remaining fixed mean-Earth-radius constant or legacy spherical distance/destination calculation was found under `src` or `server`.

## Runtime impact

None. This is a declaration-only change.
