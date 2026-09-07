# Cesium ion Google Photorealistic 3D Tiles root usage counter — 2026-09-07

## Official quota basis
- Cesium ion Community: Google Photorealistic 3D Tiles = 1,000 root tiles / month.
- Google Map Tiles API distinguishes a root tileset query from renderer-originating child-tile requests.
- A timed session token permits up to about three hours of renderer tile requests from one root tileset request.

Official references:
- https://cesium.com/platform/cesium-ion/pricing/
- https://developers.google.com/maps/documentation/tile/usage-and-billing
- https://developers.google.com/maps/documentation/tile/create-renderer

## CesiumJS 1.143 implementation alignment
CesiumJS 1.143 `createGooglePhotorealistic3DTileset()` uses Cesium ion asset 2275207 when no Google API key is supplied. It first resolves `IonResource.fromAssetId(2275207)` and only then starts the tileset root load with `Cesium3DTileset.fromUrl(resource, options)`.

AstroSight now mirrors that ordering explicitly:
1. Resolve Cesium ion asset endpoint/metadata for asset 2275207.
2. Do not count if endpoint/metadata resolution fails.
3. Immediately before `Cesium3DTileset.fromUrl(rootResource, ...)`, reserve one local root count.
4. If local counter persistence fails, do not start the root load.
5. If root-start throws synchronously, roll back the reservation.
6. Async retry re-enters this path and therefore counts as another root-start attempt.
7. Pan, zoom, camera rotation, location movement, LOD/child tile requests do not pass this counter.

## Safety thresholds
- 500: prominent warning.
- 800: the 800th root-start attempt is allowed, then future new root loads are blocked.
- Existing already-loaded renderer tiles remain usable.

## Official Usage synchronization
Cesium does not expose a documented public Usage API that AstroSight can use to read the account's official root-tile count automatically.
Therefore a device-only mirror cannot automatically include:
- usage generated before this counter version was installed,
- usage from another device using the same Cesium ion account,
- any Cesium-side accounting edge case that is not observable by the client.

The Google Tile settings therefore contain:
- `Cesium ion公式Usageを確認` — opens the official Usage dashboard.
- `公式Usageの値を手動反映` — allows the user to enter the official current value and overwrite the local mirror.

After synchronization, subsequent AstroSight root-start attempts are added from that official baseline. This is the only supported way to align an already-active account/month without a Cesium Usage API.

## Verification
`scripts/verify-cesium-root-usage-counter-20260907.mjs` verifies:
- 500 / 800 thresholds,
- removal of 3-hour deduplication,
- endpoint resolution before counting,
- use of ion asset 2275207,
- root-start count at `Cesium3DTileset.fromUrl(rootResource, ...)`,
- persistence-before-request safety,
- synchronous rollback,
- retry path,
- AR shared loader path,
- official Usage link and manual sync control.
