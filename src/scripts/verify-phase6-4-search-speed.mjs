import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const range = read('src/search/searchTimeRange.ts');
const spot = read('src/search/spotPresetSearch.ts');
const transit = read('src/search/celestialTransitSearch.ts');

assert.match(range, /export function localSearchDateParts/);
assert.match(range, /export function isMinuteWithinSearchRange/);
assert.match(range, /const local = zonedDateTimeLocalFromDate\(date, timeZone\)/);
assert.match(spot, /const allowedWeekdays = criteria\.weekdays\.length > 0\s*\? new Set\(criteria\.weekdays\)/);
assert.match(spot, /const localParts = localSearchDateParts\(date, timeZone\)/);
assert.doesNotMatch(spot, /weekdayAtLocation\(/);
assert.match(transit, /const allowedWeekdays = input\.criteria\.weekdays\.length > 0\s*\? new Set\(input\.criteria\.weekdays\)/);
assert.match(transit, /const localParts = localSearchDateParts\(date, input\.timeZone\)/);
assert.doesNotMatch(transit, /function localWeekday\(/);

console.log('Phase6-4 search speed verification passed.');
