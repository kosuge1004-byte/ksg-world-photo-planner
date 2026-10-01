# Work266 — Sony α7 V (ILCE-7M5) ARW 6.0 対応結果

実施日: 2026-08-29  
アプリ版: 0.8.7+161

## 結論

Sony α7 V（ILCE-7M5）の次の実RAW形式を、Android x86_64エミュレーター上の本番ネイティブ経路で実ファイル確認した。

- フルサイズ: 圧縮、圧縮HQ、ロスレス圧縮
- APS-C: 圧縮、圧縮HQ、ロスレス圧縮

6ファイルすべてで、単一平面2x2 Bayerセンサーデータ、有限かつ非負のFP32コピー、黒／白レベルを確認し、テストは終了コード0となった。

## 公式仕様・実装基準

- Sony公式仕様: ILCE-7M5、ARW 6.0、33 MP、静止画最大7008×4672、RAW／Compressed (HQ)／Lossless Compressed。
  - https://www.sony.com/electronics/support/e-mount-body-ilce-7-series/ilce-7m5/specifications
- LibRaw公式ソースのILCE-7M5登録とSony ARW 6デコーダーを基準にした。
  - 参照HEAD: df226ea4178ccd74245f4f13c23adddfa01411c9
  - ILCE-7M5対応: 8eb3433
  - ARW 6デコーダー: 47ea701および後続修正
- 実ARW: raw.pixls.us のILCE-7M5 CC0サンプル。
  - https://raw.pixls.us/data/SONY/ILCE-7M5/

## 実装

- Sony camera ID `0x197` と `ILCE-7M5` 正規化を追加。
- α7 Vのフルサイズ機体情報、Sony 0x9050dメタデータ群、カメラ一覧を追加。
- 公式色行列 `9089 -3577 -787 / -3563 11326 2557 / -114 928 5904` を追加。
- TIFF compression 32766／CFA photometric 32803をARW 6デコーダーへ割り当て。
- ARW 6の黒レベル1024、白レベル39002、linearity limit 32800を公式実装に合わせた。
- 公式LibRawの `sony_arw6.cpp` をライセンスヘッダー付きでベンダー領域へ追加。
- 大きなARW 6翻訳単位だけAndroid Releaseで `-O2` とし、`-O3`最適化時の過大なビルドメモリを抑制。
- arm64専用成果物用のGradleプロパティ `mobileStackArm64Only` と非arm64 JNI除外を追加。通常Debugはx86_64等を維持する。

## α7 V 実ファイル試験

| ファイル | モード | 出力センサー面 | 黒 | 白 | 最小 | 最大 | 結果 |
|---|---|---:|---:|---:|---:|---:|---|
| apcs_compressed_hq.ARW | APS-C 圧縮HQ | 4640×3088 | 1024 | 39002 | 1048 | 20424 | PASS |
| apsc_compressed.ARW | APS-C 圧縮 | 4640×3088 | 1024 | 39002 | 1045 | 16901 | PASS |
| apsc_compressed_lossless.ARW | APS-C ロスレス圧縮 | 5120×3584 | 512 | 16383 | 0 | 11344 | PASS |
| full_compressed.ARW | フルサイズ 圧縮 | 7028×4688 | 1024 | 39002 | 1036 | 22629 | PASS |
| full_compressed_HQ.ARW | フルサイズ 圧縮HQ | 7028×4688 | 1024 | 39002 | 1030 | 39002 | PASS |
| full_compressed_lossless.ARW | フルサイズ ロスレス圧縮 | 7168×5120 | 512 | 16383 | 0 | 11941 | PASS |

監査ログ: `work266_logs/06_a7v_six_format_numeric_final.log`

## 回帰結果

- Flutter analyze: PASS、0 issues
- Flutter unit/widget: PASS、834/834
- Node/source/reference: PASS、676/676
- α7 V実ARW: PASS、6/6
- Android arm64 Release build: PASS
- APK内ABI: arm64-v8aのみ
- native ABI exports: expected 10、actual 10、missing 0、unexpected 0
- applicationId: `com.mobilestack.app`
- versionName/versionCode: `0.8.7` / `161`

## APK

- ファイル: `MobileStack_Work266_Sony_A7V_arm64_release.apk`
- サイズ: 22,983,417 bytes
- SHA-256: `CA5D561044BAE110D25001EB2A6E28393465E5FB68DFE2CB5A287906803015A4`

## 判定上の注意

- 実ファイル試験は公開されたα7 V実ARWをAndroid x86_64エミュレーターへ配置し、本番FFI／LibRaw経路で実施した。
- 物理α7 V本体での撮影直後取り込み、物理Pixelでの長時間スタック／OOM、Adobe製品での最終DNG readbackは今回未実施。
- したがって「上記6形式の単一RAWデコード対応」はPASSだが、物理端末を含むアプリ全体のrelease-complete判定へは読み替えない。

