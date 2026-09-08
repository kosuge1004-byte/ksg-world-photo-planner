import fs from 'node:fs';
const site = fs.readFileSync('src/search/siteContext.ts','utf8');
const cache = fs.readFileSync('src/cache/siteContextPersistentCache.ts','utf8');
const mgr = fs.readFileSync('src/cache/tripodBearingProfileManager.ts','utf8');
const app = fs.readFileSync('src/App.tsx','utf8');
const checks = [
 ['persistent cache read before network', site.includes('readPersistentSiteContexts(points, purpose, includeDetails)')],
 ['persistent cache writes live results', site.includes('writePersistentSiteContexts(missingPoints, fetched')],
 ['water-only prefetched', mgr.includes('waterPrefetchPoints') && mgr.includes('"water-only"')],
 ['full OSM near subject prefetched', mgr.includes('detailPoints') && mgr.includes('"full"')],
 ['spot refs stored', cache.includes('REF_STORE') && cache.includes('subjectId, keys')],
 ['shared safe delete', cache.includes('referencedElsewhere') || cache.includes('const other = new Set')],
 ['delete integrated', app.includes('deletePersistentSiteContextsForSpot(subjectId)')],
 ['30d TTL', cache.includes('30 * 24 * 60 * 60 * 1000')],
];
let fail=0; for (const [name, ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) fail++; }
console.log(`${checks.length-fail}/${checks.length} PASS`); process.exitCode=fail?1:0;
