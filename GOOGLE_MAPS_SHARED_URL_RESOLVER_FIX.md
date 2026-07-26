# Google Maps shared URL resolver fix

## Problem
Short Google Maps links (`maps.app.goo.gl`) could open successfully in a browser but fail in the app with “the link opened, but coordinates could not be obtained”. The previous resolver relied mainly on the final URL returned by automatic redirect following and one HTML coordinate scan.

## Changes
- Follow redirects manually, up to eight hops, and inspect every `Location` URL for coordinates.
- Support relative redirect targets.
- Parse coordinates from the response URL and response body at every stage.
- Extract and inspect canonical URLs, Open Graph URLs, Twitter URLs, meta-refresh targets, regular Google Maps links, escaped URLs, and HTML-entity encoded URLs.
- Continue through Google consent/intermediate HTML pages when another Google Maps URL is embedded.
- Parse the current `/maps/search/latitude,+longitude` redirect format.
- Parse coordinate values from decoded `query`, `q`, `destination`, `ll`, and `center` parameters.
- Extend timeout from 12 seconds to 18 seconds.
- Return a dedicated timeout error instead of presenting it as zero search results.

## Verification
- Confirmed direct `@latitude,longitude` parsing.
- Confirmed `!3dlatitude!4dlongitude` parsing.
- Confirmed `maps.app.goo.gl` short links are recognized and routed to the server resolver.
- Confirmed a live `maps.app.goo.gl` link resolves through the spot-search UI and updates the 2D map center.
- Confirmed browser console errors and warnings are zero after the UI test.
- ZIP integrity checked after packaging.

## Build note
TypeScript, Vite production build, and lint complete successfully in the supplied project environment.
