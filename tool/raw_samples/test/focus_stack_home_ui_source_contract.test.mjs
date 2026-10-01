import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const home = readFileSync(
  new URL('../../../lib/features/home/home_screen.dart', import.meta.url),
  'utf8',
);
const app = readFileSync(
  new URL('../../../lib/app.dart', import.meta.url),
  'utf8',
);
const mode = readFileSync(
  new URL('../../../lib/core/models/processing_mode.dart', import.meta.url),
  'utf8',
);
const screen = readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart', import.meta.url),
  'utf8',
);

test('home adds the approved focus-stack card without replacing existing modes', () => {
  assert.match(home, /ProcessingMode\.milkyWay/);
  assert.match(home, /ProcessingMode\.starTrail/);
  assert.match(home, /ProcessingMode\.meteor/);
  assert.match(home, /ProcessingMode\.focusStack/);
  assert.match(home, /Color\(0xFFF08A5D\)/);
  assert.match(home, /フォーカス合成/);
  assert.match(home, /境界ブレンド/);
});

test('focus-stack route is registered and processing mode has Japanese labels', () => {
  assert.match(app, /FocusStackScreen\.routeName/);
  assert.match(mode, /focusStack/);
  assert.match(mode, /'深度合成'/);
});

test('focus-stack route is dedicated and valid inputs can launch focus analysis', () => {
  assert.match(screen, /static const String routeName = '\/focus-stack'/);
  assert.match(screen, /入力RAW/);
  assert.match(screen, /合焦位置を解析/);
  assert.match(screen, /validation\.isValid && !busy \? onPressed : null/);
});
