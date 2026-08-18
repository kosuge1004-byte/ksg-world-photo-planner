import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const commands = [
  ['TypeScript', 'npx', ['tsc', '-b', '--pretty', 'false']],
  ['Lint', 'npm', ['run', 'lint', '--', '--quiet']],
  ['Regression tests', 'npm', ['run', 'test:regression']],
  ['Production build', 'npm', ['run', 'build']],
];

const required = [
  'node_modules/typescript/package.json',
  'node_modules/vite/package.json',
  'node_modules/oxlint/package.json',
  'node_modules/@types/node/package.json',
  'node_modules/@cloudflare/workers-types/package.json',
  'node_modules/geo-tz/package.json',
];

const missing = required.filter((path) => !existsSync(path));
const report = {
  phase: '7-1',
  generatedAt: new Date().toISOString(),
  node: process.version,
  prerequisite: missing.length === 0 ? 'pass' : 'fail',
  missing,
  results: [],
};

if (missing.length > 0) {
  console.error('[Phase7-1] Dependency installation is incomplete.');
  for (const path of missing) console.error(`  missing: ${path}`);
  console.error('Run `npm ci` with access to the npm packages referenced by package-lock.json, then retry.');
  writeFileSync('PHASE7_1_VERIFICATION_RESULT.json', JSON.stringify(report, null, 2) + '\n');
  process.exit(2);
}

for (const [name, command, args] of commands) {
  console.log(`\n[Phase7-1] ${name}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  report.results.push({ name, status: result.status ?? 1 });
}

writeFileSync('PHASE7_1_VERIFICATION_RESULT.json', JSON.stringify(report, null, 2) + '\n');
const failures = report.results.filter((entry) => entry.status !== 0);
if (failures.length > 0) {
  console.error(`\n[Phase7-1] Failed: ${failures.map((entry) => entry.name).join(', ')}`);
  process.exit(1);
}
console.log('\n[Phase7-1] All foundation checks passed.');
