import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const cache = read('lib/core/background/durable_decoded_frame_cache.dart');
const bridge = read('lib/core/background/native_file_hash.dart');
const androidCmake = read('android/app/CMakeLists.txt');
const hostCmake = read('native/CMakeLists.txt');
const header = read('native/include/mobile_stack_util.h');

test('fileHash prefers the native digest and falls back to package:crypto', () => {
  assert.match(cache, /await nativeFileSha256\(file\.path\) \?\?\n\s+\(await sha256\.bind\(file\.openRead\(\)\)\.first\)\.toString\(\);/);
});

test('native hashing runs off the caller isolate and only on Android', () => {
  assert.match(bridge, /if \(!Platform\.isAndroid\) return null;/);
  assert.match(bridge, /Isolate\.run\(\(\) => _nativeFileSha256Sync\(path\)\)/);
  assert.match(bridge, /RegExp\(r'\^\[0-9a-f\]\{64\}\$'\)/);
});

test('the native source is built into the Android library and tested on the host', () => {
  assert.match(androidCmake, /\.\.\/\.\.\/native\/src\/mobile_stack_util_sha256\.c/);
  assert.match(hostCmake, /add_test\(NAME mobile_stack_util_sha256_test/);
  assert.match(header, /MOBILE_STACK_UTIL_API int mobile_stack_util_sha256_file\(const char \*path,/);
});
