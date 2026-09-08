import fs from 'node:fs';

const checks = [];
function check(name, ok) { checks.push({name, ok}); if (!ok) console.error('FAIL', name); }
const spot = fs.readFileSync('src/components/SpotSearchScreen.tsx','utf8');
const app = fs.readFileSync('src/App.tsx','utf8');
const stats = fs.readFileSync('src/cache/downloadedSpotDataStats.ts','utf8');
const gsi = fs.readFileSync('src/cesium/gsiDemTileCache.ts','utf8');
const site = fs.readFileSync('src/cache/siteContextPersistentCache.ts','utf8');
const device = fs.readFileSync('src/cache/deviceCache.ts','utf8');

check('download list shows managed total', spot.includes('管理対象'));
check('download list shows DEM/profile/OSM sizes', spot.includes('DEM') && spot.includes('地形プロファイル') && spot.includes('OSM/水面'));
check('download list supports multi select delete', spot.includes('選択削除') && spot.includes('selectedDownloadedIds'));
check('download list supports delete all', spot.includes('全削除') && spot.includes('deleteAllDownloads'));
check('download list supports refresh', spot.includes('onRefreshDownloadedSpotData'));
check('download state distinguishes complete/partial/update', spot.includes('保存完了') && spot.includes('一部不足') && spot.includes('更新が必要'));
check('app wires bulk delete', app.includes('handleDeleteDownloadedSpotDataBulk'));
check('app refreshes storage inspection', app.includes('inspectDownloadedSpotStorage(downloadedSpotData)'));
check('profile storage stats exist', stats.includes('getBearingProfileStorageStats'));
check('DEM unique physical size stats exist', gsi.includes('getGsiDownloadedSpotsTotalStorageStats'));
check('OSM/water unique size stats exist', site.includes('getPersistentSiteContextTotalStorageStats'));
check('device cache namespace byte stats exist', device.includes('getDeviceCacheNamespaceStats'));
check('StorageManager estimate is displayed when available', stats.includes('navigator.storage?.estimate?.()'));

const failed = checks.filter(c => !c.ok);
console.log(`downloaded-data-management-detail: ${checks.length-failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
