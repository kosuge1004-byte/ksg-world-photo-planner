# Work360: 保存データ検証の SHA-256 をネイティブ化（出力・保存形式は完全に同一）

## 原因
`DurableDecodedFrameCache.fileHash` は Dart（package:crypto）で SHA-256 を計算していた。
現像済みフレーム（約288MB）の公開時の検証で1枚あたり10〜18秒（Work350 実機ログ `milkyDecodedCache publish elapsedMs`）。
同じ関数は、入力RAWの識別、星の軌跡の毎フレームの最大値・合計のチェックポイント（RGB＋有効数）、深度合成の段階保存、出力の受領確認でも使われる。

## 変更
| ファイル | 内容 |
|---|---|
| native/src/mobile_stack_util_sha256.c, native/include/mobile_stack_util.h | 新規。FIPS 180-4 SHA-256（移植性のある C、1MiB 読み）。`mobile_stack_util_sha256_file` を公開 |
| android/app/CMakeLists.txt, native/CMakeLists.txt | ライブラリに追加、ホスト用テストを登録 |
| lib/core/background/native_file_hash.dart | 新規。FFI 呼び出しを短命の Isolate で実行（呼び出し側のイベントループ＝心拍・中止確認を止めない） |
| lib/core/background/durable_decoded_frame_cache.dart | fileHash はネイティブ結果を優先し、得られなければ従来の Dart 計算（エラー挙動も従来どおり） |

ハッシュ値は従来と同一の16進表記なので、既存の途中保存・受領確認はそのまま有効。画像データには触れない。

## 検証（この環境で実施）
- 既知解（空・"abc"・448ビット・100万文字 'a'）一致。
- 0, 1, 55, 56, 63, 64, 65, 1MiB±1, 300,000,123 バイトのランダムファイルで `sha256sum` と一致。
- 実際の native ライブラリ（CMake で LibRaw ごとビルド）を ctypes で呼び出し、Python hashlib と一致。存在しないファイルは -2。
- `tool/check_native_exports.sh`: 13 exports 検証 OK（既存 ABI 不変）。gcc -Wall -Wextra -Werror で警告なし。
- 速度（x86 ホスト）: 300MB を約1.5秒。端末では1枚あたり十数秒 → 数秒の見込み（未計測）。
- Node 全テスト PASS。

未実施: Android NDK（clang）でのビルド、Dart からの実行（端末）。
