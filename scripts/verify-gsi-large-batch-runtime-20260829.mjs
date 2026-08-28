import { fetchGsiElevationSamples } from '../src/cesium/gsiElevationClient.ts';
let calls=[];
const fetcher=async (_url, init)=>{
 const body=JSON.parse(init.body); calls.push(body.points);
 return new Response(JSON.stringify({samples: body.points.map((p)=>({heightMeters:p.latitude,source:'DEM10B'})),tileCacheHit:1,tileCacheMiss:0}),{status:200,headers:{'content-type':'application/json'}});
};
const points=Array.from({length:640},(_,i)=>({latitude:30+i/100000,longitude:135,maximumDetail:'10m',interpolationMode:'neutral'}));
const r=await fetchGsiElevationSamples(points,undefined,fetcher);
if(calls.length!==1) throw new Error(`640 points made ${calls.length} HTTP calls`);
if(r.samples.length!==640) throw new Error('sample length changed');
for(let i=0;i<640;i++) if(r.samples[i].heightMeters!==points[i].latitude) throw new Error(`order changed at ${i}`);
console.log('PASS 640 points => 1 HTTP request; sample order/value preserved');
