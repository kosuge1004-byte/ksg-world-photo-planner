import fs from "node:fs";
import ts from "typescript";

const reasonSource = fs.readFileSync(
  new URL("../src/celestial/occlusionReason.ts", import.meta.url),
  "utf8"
);
const componentSource = fs.readFileSync(
  new URL("../src/components/CelestialOcclusionStatus.tsx", import.meta.url),
  "utf8"
);
const styles = fs.readFileSync(
  new URL("../src/App.css", import.meta.url),
  "utf8"
);

const compiled = ts.transpileModule(reasonSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const reasonModule = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const present = reasonModule.presentCelestialOcclusionReason;

function occlusion(overrides) {
  return {
    verificationState: "dem-and-google-3d",
    visible: true,
    verified: true,
    terrainObstructed: false,
    photorealisticMeshObstructed: false,
    reason: "visible",
    ...overrides,
  };
}

const cases = [
  {
    name: "checking never becomes confirmed obstruction",
    input: occlusion({
      verificationState: "checking",
      verified: false,
      terrainObstructed: true,
      reason: "terrain",
    }),
    expected: { state: "checking", message: "遮蔽を確認中です" },
  },
  {
    name: "failed never becomes confirmed obstruction",
    input: occlusion({
      verificationState: "failed",
      verified: false,
      photorealisticMeshObstructed: true,
      reason: "building-or-surface",
    }),
    expected: { state: "unavailable", message: "遮蔽を確認できません" },
  },
  {
    name: "terrain boundary uncertainty",
    input: occlusion({
      visible: true,
      verified: false,
      reason: "unverified",
      terrainBoundaryUncertain: true,
    }),
    expected: { state: "checking", message: "地形稜線との僅差のため遮蔽は未確定です" },
  },
  {
    name: "below horizon",
    input: occlusion({ visible: false, reason: "below-horizon" }),
    expected: { state: "blocked", message: "地平線の下です" },
  },
  {
    name: "terrain obstruction with DEM only",
    input: occlusion({
      verificationState: "dem-only",
      visible: false,
      verified: false,
      terrainObstructed: true,
      reason: "terrain",
    }),
    expected: { state: "blocked", message: "山や地形に隠れています" },
  },
  {
    name: "Google 3D building obstruction",
    input: occlusion({
      visible: false,
      photorealisticMeshObstructed: true,
      reason: "building-or-surface",
    }),
    expected: { state: "blocked", message: "建物・3Dデータに隠れています" },
  },
  {
    name: "DEM complete while Google 3D is pending",
    input: occlusion({
      verificationState: "dem-only",
      verified: false,
      reason: "unverified",
    }),
    expected: { state: "checking", message: "建物の遮蔽を確認中です" },
  },
  {
    name: "DEM complete but Google 3D unavailable",
    input: occlusion({
      verificationState: "dem-only",
      verified: false,
      reason: "unverified",
      failureMessage: "mesh unavailable",
    }),
    expected: { state: "unavailable", message: "建物の遮蔽を確認できません" },
  },
  {
    name: "visible result has no constant label",
    input: occlusion({}),
    expected: null,
  },
];

for (const testCase of cases) {
  const actual = present(testCase.input);
  if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
    throw new Error(
      `${testCase.name}: expected ${JSON.stringify(testCase.expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

for (const expected of [
  'if (!visibility[id] || !result) return []',
  'if (presentations.length === 0) return null',
  'checking.map((item) => item.label).join("・")',
  'unavailable.map((item) => item.label).join("・")',
]) {
  if (!componentSource.includes(expected)) {
    throw new Error(`occlusion status aggregation is missing: ${expected}`);
  }
}
for (const expected of [
  ".celestial-occlusion-status",
  "pointer-events: none",
  "max-width: min(235px, calc(100% - 104px))",
]) {
  if (!styles.includes(expected)) {
    throw new Error(`non-obstructive occlusion status style is missing: ${expected}`);
  }
}

console.log("Celestial occlusion reason presentation verification: PASS");
