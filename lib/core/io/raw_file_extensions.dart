const Set<String> supportedRawExtensions = <String>{
  '3fr',
  'arw',
  'cr2',
  'cr3',
  'dng',
  'erf',
  'fff',
  'iiq',
  'kdc',
  'mef',
  'mos',
  'mrw',
  'nef',
  'nrw',
  'orf',
  'pef',
  'raf',
  'raw',
  'rw2',
  'rwl',
  'sr2',
  'srf',
  'srw',
  'x3f',
};

/// 現在、選択→実処理まで一貫して対応している形式。
///
/// これは「ヘッダー検査（メタデータ probe）ができる形式」ではなく、「実際に
/// `mobile_stack_raw_decode`（native/src/mobile_stack_raw_ffi_stub.c）が
/// ピクセルデコードまで成功させられる形式」を指す。この2つは同じではない：
/// CR2/CR3/DNG/ORF/PEF/RAF/RW2 はメタデータ probe（次元・撮影情報の読み取り）
/// までは成功するため、以前はここにも含まれ選択画面に表示されていたが、
/// native側のLibRawフォールバックはARW/NEF/NRWにしか配線されておらず、
/// それ以外の形式は選択・容量事前確認・ジョブ開始すべてに成功したあと、
/// 実際のデコード段階で必ず `MOBILE_STACK_RAW_UNSUPPORTED_FORMAT` になる
/// （native/src/mobile_stack_raw_ffi_stub.c の `mobile_stack_raw_decode`
/// を参照。LibRaw自体はこれらの形式もサポートしており、
/// `mobile_stack_libraw_decode` の実装自体は形式非依存だが、それを呼び出す
/// 条件分岐がARW/NEF/NRWだけに限定されている）。
///
/// 選択肢を実際にデコードできる形式だけに絞るのが、今回確認できた範囲での
/// 安全な修正。LibRaw呼び出し条件を他形式にも広げる対応は、実カメラの
/// サンプルRAW（特にFujifilm RAFのX-Trans配列など、単純なBayerパターンを
/// 前提とする現在のバッファ抽出コードと相性が悪い可能性がある機種）での
/// 検証が別途必要なため、今回は見送っている。
const Set<String> probeSupportedRawExtensions = <String>{
  'arw',
  'nef',
  'nrw',
};

bool isSupportedRawPath(String path) {
  return hasAllowedRawExtension(path, supportedRawExtensions);
}

bool isProbeSupportedRawPath(String path) {
  return hasAllowedRawExtension(path, probeSupportedRawExtensions);
}

bool hasAllowedRawExtension(String path, Set<String> allowedExtensions) {
  final int separator = path.lastIndexOf('.');
  if (separator < 0 || separator == path.length - 1) return false;
  return allowedExtensions
      .contains(path.substring(separator + 1).toLowerCase());
}
