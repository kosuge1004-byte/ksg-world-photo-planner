import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const shared=fs.readFileSync(path.join(root,"functions/_shared/r2Cache.ts"),"utf8");
const endpoints=["functions/api/geocode.ts","functions/api/timezone.ts","functions/api/osm-site-context.ts","functions/api/gsi-geoid.ts","functions/api/gsi-elevation.ts"];
const checks=[]; const check=(n,o)=>checks.push([n,!!o]);
check("shared read guard",shared.includes("allowR2Read"));
check("shared write guard",shared.includes("reserveR2Write"));
check("shared storage accounting",shared.includes("trackedObjectBytes"));
check("no shared direct delete",!shared.includes("bucket.delete("));
check("no shared head probe",!shared.includes("bucket.head("));
for(const rel of endpoints){ const s=fs.readFileSync(path.join(root,rel),"utf8"); check(rel+" passes safety KV",s.includes("SPOT_SEARCH_JOBS") && s.includes("getOrCreateR2Json(")); }
const all=[]; function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if(e.isDirectory()){ if(e.name!=="node_modules") walk(p); } else if(/\\.(ts|tsx|js|mjs)$/.test(e.name)) all.push(p); }} walk(root);
const bad=[]; for(const f of all){ const s=fs.readFileSync(f,"utf8"); if(/NETWORK_CACHE\s*\.\s*(get|put|head|delete)\s*\(/.test(s)) bad.push(path.relative(root,f)); }
check("no direct NETWORK_CACHE R2 operations",bad.length===0);
for(const [n,o] of checks) console.log(`${o?"PASS":"FAIL"} ${n}`); if(checks.some(([,o])=>!o)){ if(bad.length) console.error(bad); process.exit(1);} console.log(`PASS ${checks.length}/${checks.length}`);
