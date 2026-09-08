import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const connection = read('src/precision/cesiumIonConnection.ts');
const viewer = read('src/cesium/createMapViewer.ts');
const app = read('src/App.tsx');
const ar = read('src/components/ArCesiumOverlay.tsx');
const settings = read('src/components/TopSettingsBar.tsx');

assert(/CESIUM_ION_USAGE_WARNING_THRESHOLD\s*=\s*500/.test(connection), 'warning threshold must be 500');
assert(/CESIUM_ION_USAGE_STOP_THRESHOLD\s*=\s*800/.test(connection), 'stop threshold must be 800');
assert(!connection.includes('USAGE_SESSION_TTL_MS'), 'legacy 3-hour deduplication must be removed');
assert(!connection.includes('USAGE_SESSION_STORAGE_KEY'), 'legacy sessionStorage counter must be removed');
assert(connection.includes('startCesiumIonRootTilesetRequest'), 'root-request wrapper is missing');
assert(connection.includes('if (record.count >= CESIUM_ION_USAGE_STOP_THRESHOLD)'), '800 preflight block is missing');
assert(connection.includes('saveUsageRecord(updated);'), 'count must be durably reserved before root request starts');
assert(connection.includes('const request = startRequest();'), 'actual root request start is missing');
assert(connection.includes('saveUsageRecord(record);'), 'synchronous pre-request failure must roll back reserved count');
assert(connection.includes('setCesiumIonMonthlyUsageCountFromOfficialUsage'), 'manual official-Usage synchronization is missing');

assert(viewer.includes('IonResource.fromAssetId('), 'Cesium ion endpoint resolution must occur explicitly before root counting');
assert(viewer.includes('GOOGLE_PHOTOREALISTIC_ION_ASSET_ID = 2275207'), 'Google Photorealistic ion asset id must match CesiumJS 1.143');
assert(viewer.indexOf('const rootResource = await getGooglePhotorealisticIonResource();') < viewer.indexOf('startCesiumIonRootTilesetRequest(() =>'), 'ion endpoint resolution must complete before root counter is entered');
assert(viewer.includes('Cesium3DTileset.fromUrl(rootResource,'), 'root request must start through Cesium3DTileset.fromUrl after endpoint resolution');
const executableViewerLines = viewer.split(/\r?\n/).filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); });
assert(!executableViewerLines.some(line => line.includes('createGooglePhotorealistic3DTileset(')), 'the higher-level helper must not be used because it counts too early for exact root-attempt mirroring');
assert(viewer.includes('usageCount === CESIUM_ION_USAGE_WARNING_THRESHOLD'), '500 warning trigger missing');
assert(viewer.includes('usageCount === CESIUM_ION_USAGE_STOP_THRESHOLD'), '800 reached notice missing');
assert(viewer.includes('for (let attempt = 1; attempt <= TILESET_INITIALIZATION_ATTEMPTS; attempt += 1)'), 'retry loop missing');
assert(viewer.includes('tileset = await createPhotorealisticTilesetWithTimeout();'), 'each retry must pass through counted root loader');
assert(ar.includes('loadGooglePhotorealisticTilesetWithRetry('), 'AR must use the shared counted loader');
assert(!app.includes('recordCesiumIonHighPrecisionUsage'), 'App-level legacy mode-use counter must be removed');
assert(settings.includes('Cesium ion公式Usageを確認'), 'official Usage link is missing');
assert(settings.includes('公式Usageの値を手動反映'), 'official Usage manual reflect control is missing');

console.log('Cesium root usage counter verification: PASS');
console.log('- ion asset endpoint resolution happens before counting');
console.log('- count unit: each Cesium3DTileset.fromUrl(rootResource) root-start attempt');
console.log('- child tiles / pan / zoom: not counted by this path');
console.log('- retry: counted because it starts a fresh root load');
console.log('- localStorage failure blocks root start; synchronous start failure rolls back');
console.log('- warning: 500');
console.log('- 800th request: allowed; requests after 800 are blocked');
console.log('- existing/month-external drift can be synchronized to Cesium ion official Usage manually');
