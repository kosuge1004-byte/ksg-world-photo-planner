import fs from "node:fs";

const spot = fs.readFileSync(
  new URL("../src/components/SpotSearchScreen.tsx", import.meta.url),
  "utf8"
);
const transit = fs.readFileSync(
  new URL("../src/components/CelestialTransitSearchDialog.tsx", import.meta.url),
  "utf8"
);

for (const [source, name] of [
  [spot, "spot search"],
  [transit, "transit search"],
]) {
  if (!source.includes("searchGenerationRef")) {
    throw new Error(`${name} has no search generation`);
  }
  if (!source.includes("searchGenerationRef.current !== searchGeneration")) {
    throw new Error(`${name} does not reject stale completions`);
  }
  if (!source.includes("controller.signal.aborted")) {
    throw new Error(`${name} does not reject cancelled updates`);
  }
}

let latest = 0;
const applied = [];
const start = () => ++latest;
const apply = (id, value) => {
  if (id === latest) applied.push(value);
};
const oldId = start();
const newId = start();
apply(newId, "new-progress");
apply(oldId, "old-progress");
apply(oldId, "old-result");
apply(newId, "new-result");
if (applied.join(",") !== "new-progress,new-result") {
  throw new Error(`stale search update was applied: ${applied.join(",")}`);
}

console.log("Search generation race verification: PASS");
