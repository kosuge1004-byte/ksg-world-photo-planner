import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const scriptsDirectory = path.join(root, "scripts");
const outputArgumentIndex = process.argv.indexOf("--output");
const outputPath = path.resolve(
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1]
    ? process.argv[outputArgumentIndex + 1]
    : path.join(root, "evidence", "verify-all-latest.json")
);

const names = (await fs.readdir(scriptsDirectory))
  .filter((name) => /^verify-.*\.mjs$/i.test(name))
  .sort();
const results = [];

for (let index = 0; index < names.length; index += 1) {
  const name = names[index];
  const startedAt = Date.now();
  const execution = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(path.join(scriptsDirectory, "register-typescript-source-loader.mjs")).href,
      path.join(scriptsDirectory, name),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    }
  );
  const result = {
    name,
    passed: execution.status === 0 && execution.error === undefined,
    exitCode: execution.status,
    signal: execution.signal,
    durationMs: Date.now() - startedAt,
    error: execution.error?.message ?? null,
    stdout: execution.stdout ?? "",
    stderr: execution.stderr ?? "",
  };
  results.push(result);
  console.log(`[${index + 1}/${names.length}] ${result.passed ? "PASS" : "FAIL"} ${name}`);
  if (!result.passed) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    if (detail) console.error(detail.slice(-8_000));
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  total: results.length,
  passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length,
  results,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`verification summary: ${report.passed}/${report.total} PASS`);
console.log(`report: ${outputPath}`);
if (report.failed > 0) process.exitCode = 1;
