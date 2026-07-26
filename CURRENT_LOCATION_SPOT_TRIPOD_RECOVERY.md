# Current location / spot search / tripod candidate recovery

- Current-location action now exits all map placement modes before requesting location.
- 2D and 3D map centers are updated with a fresh state object.
- Tripod candidate terrain sampling now falls back to the subject elevation when GSI/Cesium terrain retrieval fails or returns invalid heights.
- The same resilient candidate engine is shared by the main-map candidate display and spot search.
