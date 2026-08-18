# PLATEAU terrain alignment fix

- Added the official PLATEAU-Terrain quantized-mesh provider to standard mode.
- PLATEAU buildings are loaded only after the terrain provider succeeds.
- If terrain loading fails, standard mode continues with the GSI imagery layer and does not display floating PLATEAU buildings.
- No fixed height offset is applied.
- PLATEAU buildings remain display-only and are not connected to search, obstruction, line-of-sight, or height calculations.

Terrain endpoint:
`https://tile.plateauview.mlit.go.jp/terrain/`
