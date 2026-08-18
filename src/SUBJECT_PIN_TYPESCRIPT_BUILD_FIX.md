# Subject pin TypeScript build fix

- Fixed `src/cesium/subjectPin.ts` TS18048.
- Changed `entity.name` to `entity?.name` after optional entity lookup.
- ZIP integrity verified after packaging.
- Full local build could not complete because the supplied archive does not contain the required `vite/client` and Node type definitions.
