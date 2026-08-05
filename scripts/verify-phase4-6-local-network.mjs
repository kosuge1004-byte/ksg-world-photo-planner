import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server/surfaceObstructionLineOfSight.ts", import.meta.url), "utf8");

assert.match(source, /surfaceQueryBounds/);
assert.match(source, /calculateKarneyDestinationPoint/);
assert.match(source, /way\["building"\]\(\$\{bbox\}\)/);
assert.doesNotMatch(source, /way\(\$\{around\}\)\["building"\]/);
assert.match(source, /origin\.latitude\.toFixed\(5\)/);
assert.match(source, /origin\.longitude\.toFixed\(5\)/);
assert.match(source, /SURFACE_LOS_CORRIDOR_HALF_WIDTH_METERS/);

console.log("Phase4-6 local-network verification: PASS");
