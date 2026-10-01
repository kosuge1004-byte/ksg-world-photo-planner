import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screen=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart',import.meta.url),
  'utf8',
);
const exporter=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_linear_dng_export.dart',import.meta.url),
  'utf8',
);
const android=readFileSync(
  new URL('../../../android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt',import.meta.url),
  'utf8',
);

test('completed focus stack exposes an explicit Linear DNG save action',()=>{
  assert.match(screen,/outputFormat\.label/);
  assert.match(screen,/_saveLastResult/);
  assert.match(screen,/exportFocusStackResult/);
});

test('save stages a DNG then streams its file path through ResultFileActions',()=>{
  assert.match(screen,/focus_stack_\$stamp\.\$\{format\.extension\}/);
  assert.match(screen,/Directory\.systemTemp\.createTemp/);
  assert.match(screen,/_resultFileActions\.saveCopy/);
  assert.doesNotMatch(screen,/readAsBytes/);
});

test('temporary DNG staging directory is deleted after every save attempt',()=>{
  assert.match(screen,/temporary\.delete\(recursive: true\)/);
  assert.match(screen,/finally/);
});

test('Android MediaStore accepts DNG and streams from FileInputStream',()=>{
  assert.match(android,/setOf\("bmp", "jpg", "jpeg", "tif", "tiff", "dng"\)/);
  assert.match(android,/"dng" -> "image\/x-adobe-dng"/);
  assert.match(android,/FileInputStream\(source\)/);
  assert.match(android,/input\.copyTo\(destination, DEFAULT_BUFFER_SIZE\)/);
});

test('DNG exporter remains the existing high-quality float export path',()=>{
  assert.match(exporter,/exportTileStoreToLinearDng/);
  assert.match(exporter,/profile\.outputTransform\(result\.cfaPattern\)/);
  assert.match(exporter,/transparencyMaskSource: result\.coverageMask/);
});

test('saving state blocks duplicate save and main processing actions',()=>{
  assert.match(screen,/_isSaving/);
  assert.match(screen,/saving \? null : onSave/);
  assert.match(screen,/busy: _isAnalyzing \|\| _isStacking \|\| _isSaving/);
});
