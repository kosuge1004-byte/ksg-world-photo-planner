import assert from 'node:assert/strict';
import { resolveJapanesePlaceName } from '../server/placeGeocode.ts';

function response(json, delay=0) {
  return new Promise((resolve)=>setTimeout(()=>resolve({ ok:true, json: async()=>json }), delay));
}

// GSI returns first and has a short exact title at a wrong coordinate.
// Nominatim returns later with an exact POI name for the castle.
const fetcher = async (url) => {
  if (String(url).includes('msearch.gsi.go.jp')) {
    return await response([{ geometry:{type:'Point',coordinates:[136.70,35.40]}, properties:{title:'岐阜城'} }], 5);
  }
  if (String(url).includes('nominatim.openstreetmap.org')) {
    return await response([{ lat:'35.4339', lon:'136.7820', display_name:'岐阜城, 金華山, 岐阜市, 岐阜県, 日本', name:'岐阜城', category:'historic', type:'castle', importance:0.6 }], 30);
  }
  throw new Error('unexpected url '+url);
};
const result = await resolveJapanesePlaceName('岐阜城', undefined, fetcher);
assert.equal(result.latitude, 35.4339);
assert.equal(result.longitude, 136.7820);
assert.match(result.label, /^岐阜城/);
console.log('PASS: slower exact Nominatim castle POI wins over faster GSI short exact label');
