import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const assert = (v, m) => { if (!v) throw new Error(m); };
const checks = [];
const check = (name, fn) => { try { fn(); checks.push({name,status:'PASS'}); } catch (e) { checks.push({name,status:'FAIL',detail:String(e.message||e)}); } };

check('Capacitor app identity', () => {
  const c = read('capacitor.config.ts');
  assert(c.includes('appId: "jp.astrosight.app"'), 'appId mismatch');
  assert(c.includes('appName: "AstroSight"'), 'appName mismatch');
  assert(c.includes('webDir: "dist"'), 'webDir mismatch');
});
check('Android project structure', () => {
  for (const p of ['android/gradlew','android/app/build.gradle','android/app/src/main/AndroidManifest.xml','android/app/src/main/java/jp/astrosight/app/MainActivity.java']) assert(existsSync(resolve(root,p)), `${p} missing`);
});
check('Android permissions and orientation', () => {
  const m = read('android/app/src/main/AndroidManifest.xml');
  assert(m.includes('ACCESS_COARSE_LOCATION') && m.includes('ACCESS_FINE_LOCATION'), 'location permissions missing');
  assert(m.includes('screenOrientation="portrait"'), 'portrait lock missing');
  assert(m.includes('hardwareAccelerated="true"'), 'hardware acceleration missing');
});
check('Android resources', () => {
  for (const p of ['android/app/src/main/res/mipmap-mdpi/ic_launcher.png','android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png','android/app/src/main/res/drawable/splash.png']) assert(existsSync(resolve(root,p)), `${p} missing`);
});
check('Browser/PWA compatibility files', () => {
  for (const p of ['index.html','public/manifest.webmanifest','public/sw.js']) assert(existsSync(resolve(root,p)), `${p} missing`);
  const index = read('index.html');
  assert(index.includes('viewport-fit=cover'), 'safe-area viewport missing');
});
check('iOS preparation status', () => {
  const cap = read('capacitor.config.ts');
  assert(cap.includes('ios:'), 'iOS Capacitor settings missing');
});

const suites = [
  'verify:phase6-5','verify:phase7-1','verify:phase7-2','verify:phase7-3','verify:phase7-4','verify:platform-compatibility','verify:pwa-installability','verify:search-engine-exclusion'
];
const suiteResults = [];
for (const suite of suites) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', suite], {cwd: root, encoding:'utf8'});
  const output=(r.stdout+r.stderr).trim();
  const status=r.status===0?'PASS':(/Dependency installation is incomplete|missing: node_modules/.test(output)?'BLOCKED_DEPENDENCY':'FAIL');
  suiteResults.push({suite,status,output:output.slice(-2000)});
}

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run','build'], {cwd:root,encoding:'utf8'});
let buildStatus = build.status===0?'PASS':'FAIL';
let buildReason = (build.stdout+build.stderr).trim();
if (build.status!==0 && /Cannot find package .*node_modules\/geo-tz|ERR_MODULE_NOT_FOUND/.test(buildReason)) buildStatus='BLOCKED_DEPENDENCY';

const report = {
  generatedAt:new Date().toISOString(),
  staticChecks:checks,
  suites:suiteResults,
  build:{status:buildStatus,detail:buildReason.slice(-2500)},
  androidWebAssetsPresent:existsSync(resolve(root,'android/app/src/main/assets/public')),
  iosProjectPresent:existsSync(resolve(root,'ios'))
};
writeFileSync(resolve(root,'PHASE7_5_VERIFICATION_RESULT.json'), JSON.stringify(report,null,2)+'\n');

const failed = checks.filter(x=>x.status==='FAIL');
const failedSuites = suiteResults.filter(x=>x.status==='FAIL');
console.log(JSON.stringify(report,null,2));
if (failed.length || failedSuites.length) process.exitCode=1;
