import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(projectRoot, "src");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

for (const configPath of ["tsconfig.app.json", "tsconfig.node.json", "tsconfig.server.json"]) {
  const parsedConfig = ts.parseConfigFileTextToJson(configPath, read(configPath));
  if (parsedConfig.error) {
    throw new Error(`${configPath}: TypeScript configuration could not be parsed`);
  }
  const config = parsedConfig.config;
  if (config.compilerOptions?.strict !== true) {
    throw new Error(`${configPath}: strict mode is not enabled`);
  }
}

const packageJson = JSON.parse(read("package.json"));
for (const dependency of ["ol", "resium"]) {
  if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
    throw new Error(`unused dependency remains: ${dependency}`);
  }
}

const removedFiles = [
  "src/components/FocalLengthPanel.tsx",
  "src/components/MobileBottomNav.tsx",
  "src/assets/hero.png",
  "src/assets/react.svg",
  "src/assets/vite.svg",
];
for (const relativePath of removedFiles) {
  if (fs.existsSync(path.join(projectRoot, relativePath))) {
    throw new Error(`unused file remains: ${relativePath}`);
  }
}

const sourceFiles = walk(sourceRoot).filter((filePath) => /\.(?:ts|tsx|css)$/.test(filePath));
const normalizedSourceFiles = new Set(sourceFiles.map((filePath) => path.normalize(filePath)));
const dependencyGraph = new Map();

function resolveSourceImport(importer, specifier) {
  const basePath = path.resolve(path.dirname(importer), specifier);
  const withoutJavaScriptExtension = basePath.replace(/\.js$/, "");
  const candidates = [
    basePath,
    withoutJavaScriptExtension,
    `${withoutJavaScriptExtension}.ts`,
    `${withoutJavaScriptExtension}.tsx`,
    `${withoutJavaScriptExtension}.css`,
    path.join(withoutJavaScriptExtension, "index.ts"),
    path.join(withoutJavaScriptExtension, "index.tsx"),
  ].map((candidate) => path.normalize(candidate));
  return candidates.find((candidate) => normalizedSourceFiles.has(candidate));
}

for (const filePath of sourceFiles) {
  const normalizedPath = path.normalize(filePath);
  if (filePath.endsWith(".css")) {
    dependencyGraph.set(normalizedPath, []);
    continue;
  }
  const importedFiles = ts.preProcessFile(fs.readFileSync(filePath, "utf8"), true, true)
    .importedFiles
    .map(({ fileName }) => fileName)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveSourceImport(filePath, specifier))
    .filter((resolvedPath) => resolvedPath !== undefined);
  dependencyGraph.set(normalizedPath, importedFiles);
}

const reachable = new Set();
function visit(filePath) {
  if (reachable.has(filePath)) return;
  reachable.add(filePath);
  for (const dependency of dependencyGraph.get(filePath) ?? []) visit(dependency);
}
visit(path.normalize(path.join(sourceRoot, "main.tsx")));

const unreachable = sourceFiles
  .map((filePath) => path.normalize(filePath))
  .filter((filePath) => !filePath.endsWith(".d.ts") && !reachable.has(filePath))
  .map((filePath) => path.relative(projectRoot, filePath));
if (unreachable.length > 0) {
  throw new Error(`unreachable source modules: ${unreachable.join(", ")}`);
}

const productionSources = sourceFiles
  .filter((filePath) => !filePath.endsWith(".d.ts"))
  .map((filePath) => fs.readFileSync(filePath, "utf8"))
  .join("\n");
if (/console\.(?:log|debug|info)\s*\(/.test(productionSources)) {
  throw new Error("production debug logging remains");
}
if (/(?:\bas\s+any\b|:\s*any\b|<any>|Array<any>|Promise<any>)/.test(productionSources)) {
  throw new Error("explicit any type remains in production source");
}
if (/\b(?:TODO|FIXME|HACK)\b/.test(productionSources)) {
  throw new Error("unfinished marker remains in production source");
}

console.log(JSON.stringify({
  strictTypeScriptProjects: 3,
  sourceFiles: sourceFiles.length,
  unreachableSourceModules: 0,
  explicitAnyTypes: 0,
  productionDebugLogs: 0,
  removedUnusedFiles: removedFiles.length,
  removedUnusedDependencies: 2,
}));
