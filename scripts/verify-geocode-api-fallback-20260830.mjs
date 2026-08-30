import { resolveSpotLocation } from '../src/search/spotPresetSearch.ts';

const originalFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push(url);
  if (url === '/api/geocode') {
    return new Response(JSON.stringify({ error: '一時的なAPI障害' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.startsWith('https://nominatim.openstreetmap.org/search?')) {
    return new Response(JSON.stringify([{
      lat: '35.3884', lon: '136.9392', display_name: '犬山城, 犬山市, 愛知県, 日本'
    }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

try {
  const result = await resolveSpotLocation('犬山城');
  if (Math.abs(result.latitude - 35.3884) > 1e-9 || Math.abs(result.longitude - 136.9392) > 1e-9) {
    throw new Error(`unexpected coordinates: ${JSON.stringify(result)}`);
  }
  if (!calls.includes('/api/geocode') || !calls.some((url) => url.startsWith('https://nominatim.openstreetmap.org/search?'))) {
    throw new Error(`fallback path was not exercised: ${JSON.stringify(calls)}`);
  }
  console.log('PASS: /api/geocode JSON error falls back to direct Nominatim search');
} finally {
  globalThis.fetch = originalFetch;
}
