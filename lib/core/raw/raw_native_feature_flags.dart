const String nativeDngMetadataFlagName = 'MOBILE_STACK_ENABLE_DNG_METADATA';

/// 実DNGメタデータ検査は明示的なビルド指定がある場合だけ有効化する。
const bool nativeDngMetadataEnabled = bool.fromEnvironment(
  nativeDngMetadataFlagName,
  defaultValue: false,
);
