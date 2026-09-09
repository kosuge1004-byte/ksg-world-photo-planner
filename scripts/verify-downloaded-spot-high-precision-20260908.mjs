import fs from 'node:fs';
const app=fs.readFileSync('src/App.tsx','utf8');
const screen=fs.readFileSync('src/components/SpotSearchScreen.tsx','utf8');
const manager=fs.readFileSync('src/cache/tripodBearingProfileManager.ts','utf8');
const dem=fs.readFileSync('src/cesium/gsiDemTileCache.ts','utf8');
const jobRunner=fs.readFileSync('server/runBearingProfileDownloadJob.ts','utf8');
const checks=[
 ['download registry wired', app.includes('upsertDownloadedSpotData') && app.includes('downloadedSpotData={downloadedSpotData}')],
 ['download list menu', screen.includes('ダウンロード済みデータ') && screen.includes('onDeleteDownloadedSpotData')],
 ['favorite state shown separately', screen.includes('お気に入り未登録')],
 // 2026-09-08追記: 1m高精度取得はサーバー側ジョブ(computeBearingProfile)へ
 // 移動した。10m粗探索→1m高精度で上書きする二段構えの方針自体は不変。
 ['high precision DEM sampled server-side', jobRunner.includes('"10m"') && jobRunner.includes('"1m"')],
 ['high precision progress tracked', manager.includes('highPrecisionPoints')],
 ['valid DEM tiles not count-evicted', dem.includes('PERSISTED_MAX_ENTRIES = Number.POSITIVE_INFINITY')],
 ['spot delete removes registry', app.includes('removeDownloadedSpotData(subjectId)')],
];
let fail=0; for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)fail++;} if(fail)process.exit(1); console.log(`PASS ${checks.length}/${checks.length}`);
