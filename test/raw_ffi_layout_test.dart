import 'dart:ffi';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';

void main() {
  test('64-bit Native RAW ABI v1のDart構造サイズを固定する', () {
    expect(sizeOf<IntPtr>(), 8, reason: 'CIと配布対象は64-bit ABIです。');
    expect(sizeOf<MobileStackRawDecodeRequestNative>(), 40);
    expect(sizeOf<MobileStackRawDecodeResultNative>(), 136);
  });

  test('64-bitメタデータ拡張のDart構造サイズを固定する', () {
    expect(sizeOf<IntPtr>(), 8, reason: 'CIと配布対象は64-bit ABIです。');
    expect(sizeOf<MobileStackRawMetadataProbeRequestNative>(), 24);
    expect(sizeOf<MobileStackRawMetadataProbeResultNative>(), 304);
  });
}
