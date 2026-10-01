import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const settings = fs.readFileSync(new URL('lib/features/settings/settings_screen.dart', root), 'utf8');
const formats = fs.readFileSync(new URL('lib/core/export/output_image_format.dart', root), 'utf8');
const prefs = fs.readFileSync(new URL('lib/core/settings/app_settings.dart', root), 'utf8');
const selection = fs.readFileSync(new URL('lib/features/common/raw_selection_screen.dart', root), 'utf8');
const focus = fs.readFileSync(new URL('lib/features/focus_stack/focus_stack_screen.dart', root), 'utf8');
const exportResult = fs.readFileSync(new URL('lib/core/export/export_result.dart', root), 'utf8');
const dng = fs.readFileSync(new URL('lib/core/export/linear_dng_writer.dart', root), 'utf8');

test('settings exposes JPEG TIFF and Linear DNG with explanation-only choices', () => {
  assert.match(prefs, /OutputImageFormat\.jpeg/);
  assert.match(prefs, /OutputImageFormat\.tiff16/);
  assert.match(prefs, /OutputImageFormat\.linearDng/);
  assert.doesNotMatch(prefs, /OutputImageFormat\.bmp8,/);
  assert.match(settings, /format\.detail/);
  assert.doesNotMatch(settings, /速度.*★|容量.*★|編集耐性|3段階/);
});

test('format descriptions match the requested user-facing purpose', () => {
  assert.match(formats, /JPEG — 速度・容量優先/);
  assert.match(formats, /TIFF 16bit — 高画質な汎用編集用/);
  assert.match(formats, /Linear DNG — 最高画質・RAW編集用/);
});

test('selected default persists and feeds normal and focus-stack workflows', () => {
  assert.match(prefs, /SharedPreferencesAsync/);
  assert.match(selection, /AppSettings\.loadOutputFormat\(\)/);
  assert.match(focus, /AppSettings\.loadOutputFormat\(\)/);
});

test('JPEG has a real encoder path and DNG remains uncompressed', () => {
  assert.match(exportResult, /Future<File> exportTileStoreToJpeg/);
  assert.match(exportResult, /img\.encodeJpg/);
  assert.match(exportResult, /OutputImageFormat\.jpeg => exportTileStoreToJpeg/);
  assert.match(dng, /Compression = none/);
});
