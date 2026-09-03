# AstroSight 3D consolidated regression check

Static checks: 23/23 PASS

- PASS: 3D render loop uses Viewer.render
- PASS: 3D placement handler does not reject placement modes
- PASS: 3D subject surface placement wired
- PASS: 3D tripod surface placement wired
- PASS: 3D foreground surface placement wired
- PASS: ForegroundPlacementSource includes map-3d-surface
- PASS: 2D placement overlay remains 2D-only
- PASS: 2D to 3D center sync present
- PASS: 3D to 2D center sync present
- PASS: 3D plus/minus changes Cesium camera
- PASS: 3D pin button is standalone
- PASS: 3D pin button is directly before zoom control
- PASS: 3D pin button pushed above bottom zoom control
- PASS: 3D pin button has no rail background
- PASS: Right current-location button moves Cesium
- PASS: Right subject button moves Cesium
- PASS: Right tripod button moves Cesium
- PASS: Spot subject search moves Cesium
- PASS: Spot tripod search moves Cesium
- PASS: Stored subject moves Cesium
- PASS: Tripod candidate overlay removed from map
- PASS: Tripod candidate status is in bottom status
- PASS: Bottom status stays under transit dialog

TypeScript full build note: local `tsc -b` could not proceed because the source ZIP does not include node_modules (missing vite/client, node, @cloudflare/workers-types). `npm ci` was attempted but the execution environment timed out. Therefore a complete dependency-resolved build is not claimed here.
