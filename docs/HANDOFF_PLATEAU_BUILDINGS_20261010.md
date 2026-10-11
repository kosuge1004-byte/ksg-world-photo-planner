# 引継ぎ: PLATEAU建物データの取り込み後の作業（2026-10-10）

この文書は、次の担当（Codex）が、取り込み完了後の「ファイル移動」と「その後の実装」を続けて行うためのものです。
このZIP（`AstroSight-plateau-handoff-20261010-WINDOWS.zip`）が最新のソース一式です。

## 0. 必ず守る条件（ユーザーの指示。違反すると強く叱られます）

1. **返答は日本語、結論を先に、平易に。** 「誰が・何を・どの順でやるか」を具体的に書く。抽象的な説明は不可。
2. **未確認のことは未確認と書く。** 実機・実データで確かめていないものを「できた」と言わない。
3. **精度最優先。** 速さや容量のために精度を落とさない。数値を丸めない・間引かない・推測で直さない。
   速度が落ちる修正をするときは、同じ納品の中で、精度を落とさない高速化も探す。
4. **内部の構成を利用者に見せない。** アプリの画面の文言・エラー文・配布物に入る識別子に、
   「PC」「Eドライブ」「Tunnel」「R2」「Cloudflare」「ローカルDEM」、内部のURLや内部エラー文を出さない。
   内部のエラー文はコンソールか「詳細をコピー」ボタンだけ（URLはホスト名までに伏せる）。
   ※ PC上でユーザー本人が実行する道具（`tools/` 以下）の画面表示は対象外だが、中立な書き方を保つ。
5. **頼まれていない実装はしない。** 「調べて」は報告のみ。判断が要る点は都度質問する。
6. **地図の表示領域を狭くする変更はしない。** Cesium/Googleのロゴは触らない。
7. **診断に所要時間を出す機能は不要。**
8. 納品は、作業コピーを直して `…-WINDOWS.zip` を返す形。APK化は不要。
   ZIPの作り方: `rm -rf dist && zip -qr <出力> . -x "node_modules/*" "dist/*" ".wrangler/*" "android/app/build/*" "android/.gradle/*"`
9. 回帰テストは `npm test`（`scripts/run-regression-tests.mjs`）。現在 **90グループすべてPASS**。新しい道具・機能にはテストを足す。

## 1. いまの状態

- ユーザーのPCで、取り込みの道具（`tools/plateau-building-ingest/`、配布名 `PLATEAU-Building-Ingest.zip`）が実行中。
- **いまの保存先（仮）**: `E:\AstroSight-GSI-data-20260926\runtime\gsi-dem-converter\downloads`
- **最終的な置き場所（ユーザーの希望）**: 変換後の国土地理院データと同じ場所の中
  `E:\AstroSight-GSI-data-20260926\dem\r2-ready\plateau-buildings`
  （`r2-ready` は `tools/local-dem-server/start.ps1` の `-DataRoot` 既定値 = 環境変数 `LOCAL_DEM_DATA_ROOT`）
- 道具は **実際の配布元に対しては今回が初めての実行**。事前に確認できたのは、実物の建物ファイル2つ
  （札幌市 LOD1のみ／横須賀市 LOD2・BuildingPartあり。`tools/plateau-building-ingest/fixtures/`）と模擬サーバーだけ。

### 取り込みの対象と規模（事前調査の実数）

- 対象: 311データセット、建物ファイル 38,473個、ダウンロード量 約17.2 GB（展開後 約340 GB相当を流し読みして抜き出す）。
- 一覧: `tools/plateau-building-ingest/plateau-building-ingest-targets.json`
- 外したもの: 東京23区の2022年度一括版（23区すべてに2025年度の区ごとの版があるため）、2020年度の7z版。
- `special: true` の4個（`plateau-dt23-05`、`plateau-uc23-11`、`plateau-uc23-17`、`plateau-tokyo23ku-2023-lod4`）は
  通常の市区町村版ではない。**アプリで使うかどうかは未決定**（既定では使わないのが安全。使う前にユーザーへ確認）。

## 2. 保存されるデータの形（`schema: 1`）

保存先の直下:

| 名前 | 内容 |
|---|---|
| `buildings/<データセット名>/<元のファイル名>.ndjson.gz` | 1行目が見出し、2行目以降が建物1件ずつ |
| `manifest.ndjson` | 取り込み済みファイルの一覧（1行=1ファイル）。再開の判定にも使う |
| `summary.json` | 件数・容量の集計。`complete: true` なら全件成功 |
| `failures.json` | 失敗の一覧（空配列なら失敗なし） |
| `SOURCE.txt` | 出典の表示 |

`manifest.ndjson` の1行:
`{ dataset, year, cityCode, special, entry, mesh, file, bbox:[南,西,北,東], buildings, written, withoutGeometry, badCoordinatePolygons, maxLod, sourceBytes, downloadedBytes, crc, storedBytes }`
- `file` は保存先からの相対パス（`/` 区切り）。建物が0件のファイルは `file: null`。
- `mesh` は元のファイル名の先頭の数字（地域メッシュコード）。

建物1件（1行）:
```
{ id, mh, pmh, ht, bad, b:[南,西,北,東],
  l0: { k:"re"|"fp", p:[面...] },
  l:  { "1": { z:[最低,最高], t:[面...], zi:[最低,最高], ti:[面...] }, "2": {...}, ... } }
```
- 面 = `[外周, 穴...]`。外周・穴 = `[緯度,経度,高さ, 緯度,経度,高さ, ...]`（平らな配列）。
- **座標は元データの値そのまま**（JGD2011の緯度・経度、EPSG:6697）。**高さは元データの標高（東京湾平均海面）そのまま**。
  楕円体高への換算はしていない。アプリ側の既存のジオイド処理（地点ごとのJPGEO2024）で扱うこと。
- `l` のキーは形状の詳細度（LOD）。`z` は建物本体の高さの範囲、`t` は本体の「上を向いた面」。
  - 面の種類が書かれているLOD（LOD2以上）: `RoofSurface` と `OuterFloorSurface` だけを `t` に入れる。
  - 面の種類が無い立体（LOD1の箱）: 鉛直な面と底面を除いた面を `t` に入れる。
- `zi` / `ti` は屋上の付属物（`BuildingInstallation`。塔屋・設備など）。本体とは分けてある。
- `l0` は LOD0 の輪郭（`re`=屋根の外形、`fp`=接地の外形）。
- `mh` = `bldg:measuredHeight`（建物全体）、`pmh` = BuildingPartごとの値、`ht` = `uro:lod1HeightType` のコード
  （LOD1の箱の高さが「中央値」か「最高値」か等を表す。**LOD1の `z[1]` を屋根の最高点として扱ってよいかはこの値に依存する**）。
- `bad` = 座標を読めずに捨てた面の数（その建物の形状は不完全）。
- 屋内の要素（Room 等）と ClosureSurface は読み飛ばしている。

実装: `tools/plateau-building-ingest/cityGmlBuildings.mjs`（抜き出し）、`remoteZip.mjs`（ZIPの部分取得・CRC検査）、
`plateau-building-ingest.mjs`（全体の流れ・再開）。テスト: `plateau-building-ingest.test.mjs`。

## 3. やること（順番どおりに）

### 手順A: 取り込みの完了を確認する

1. ユーザーの黒い画面に「===== 結果 =====」が出ていること。
2. 仮の保存先の `summary.json` を読む。`complete: true` かつ `files == expectedFiles`（38,473）なら完了。
3. `failures.json` が空でなければ、**移動の前に**原因を分類する。
   - 通信の失敗: もう一度 `PLATEAU-Building-Ingest.cmd` を実行すれば、失敗分だけやり直す。
   - 「未対応の圧縮方式です（方式9 など）」: Deflate64 等。Node標準では展開できない。対応方法をユーザーに提案してから実装する。
   - 「座標系が想定外です」「文字コードが想定外です」「XMLが途中で終わっています」: 推測で通さない。該当ファイルを調べて報告する。
4. `summary.json` の `withoutGeometry`（形状が無い建物）と `badCoordinatePolygons`（読めなかった面）が多いデータセットが無いか、
   `manifest.ndjson` をデータセット別に集計して確認する。偏りがあれば、その都市の書き方に道具が合っていない可能性がある。
5. 確認結果（件数・容量・LOD別の内訳・失敗の内訳）をユーザーへ報告する。

### 手順B: ファイルを最終的な場所へ移す

1. 取り込みの画面が閉じていること（実行中に移さない）。地形サーバーは止めなくてよい（別のフォルダーなので影響しない）。
2. 移動元の中身のうち、**取り込みの道具が作ったものだけ**を移す:
   `buildings\`、`manifest.ndjson`、`summary.json`、`failures.json`、`SOURCE.txt`
   （`downloads` フォルダーには国土地理院の変換用の別のファイルがある可能性がある。**フォルダーごと移さない。中身を確認してから**。）
3. 移動先: `E:\AstroSight-GSI-data-20260926\dem\r2-ready\plateau-buildings\`（無ければ作る）。同じドライブ内なので移動は一瞬で終わる。
   `r2-ready` の直下には置かない（国土地理院のデータと混ざる）。
4. 移動後、`manifest.ndjson` の全行について `file` の実体があることを確かめる（`file: null` の行は除く）。
5. 道具を展開したフォルダーの `ingest-settings.json` の `outputDirectory` を移動先に書き換える
   （後で再実行したとき、同じ場所に続きを書けるようにするため）。
6. `r2-ready` を外部の保管先へ同期する仕組みがある場合は、`plateau-buildings` が意図せず同期対象に入らないか確認する
   （`docs/GSI_DEM_LOCAL_R2.md`、`docs/LOCAL_DEM_ORIGIN_SETUP.md` を参照）。入るなら、どうするかユーザーに確認する。

### 手順C: 「地点の建物の高さ」を答える仕組みを作る（第3段階）

目的: 被写体ピンなどの屋根の高さを、手元の建物データから返す。手元のデータで答えられないときだけ、いまの方法に戻る。

現状（変更前）の屋根の高さの出し方:
- `src/cesium/plateauBuildingVerification.ts` の `resolvePlateauRoofGroundPoint(viewer, latitude, longitude, label, signal)` が、
  国交省が配信する PLATEAU の 3D Tiles を Cesium に読み込み、`clampToHeightMostDetailed` で屋根を探す（3段階の探索、全体15秒の上限）。
  呼び出し元は `src/App.tsx` の `resolveSearchSubject` 付近（2か所）と `src/components/LandmarkHeightAuditPanel.tsx`。
- 併用: `src/height/osmSubjectHeightFallback.ts`（OSM）、`src/height/registeredStructureHeight.ts`（既知の高さ）、
  選択は `src/height/subjectSurfaceResolution.ts` の `selectSubjectSurfacePoint`。

作るもの:

1. **PC側のサーバー**（`tools/local-dem-server/`）
   - 起動時に `<LOCAL_DEM_DATA_ROOT>/plateau-buildings/manifest.ndjson` を読み、ファイルごとの `bbox` で引ける索引をメモリーに作る
     （フォルダーが無ければ、この機能だけ無効にして他は今までどおり動かす）。
   - 新しい口（既存の `/v1/elevation/batch` などと同じ認証・入力検査の作法に合わせる。`app.ts` 参照）:
     入力 = 緯度・経度（複数可）、出力 = その点を含む建物ごとに
     `{ dataset, year, id, lod, 屋根の高さ（その点での面の高さ）, 建物本体の最低・最高, 付属物の最高, mh, ht, 面が見つからなかった理由 }`。
   - 点が面の中かどうかは、緯度・経度の平面で判定する（穴を考慮）。その点での高さは、面を含む平面から求める（LOD2の傾いた屋根）。
     複数の面が重なる場合は全部返し、どれを採るかは呼び出し側で決める（勝手に丸めない）。
   - 同じ場所に複数のデータセットがある場合は、`special` でないもののうち年度が新しいものを優先する。
   - 読んだ `.ndjson.gz` は展開結果を上限つきでメモリーに保持する（同じ場所の再問い合わせを速くするため）。
2. **中継**（`functions/api/` に新しいPages Function）
   - 既存の `functions/api/gsi-elevation.ts` と `functions/_shared/env.ts` の作法に合わせる（上限・検査・エラーの伏せ方）。
   - PC側に届かないときは、内部の事情が分からない一般的な失敗として返す（条件4）。
3. **アプリ**
   - `resolvePlateauRoofGroundPoint` を呼ぶ前に、新しい口へ問い合わせる。答えが得られたらそれを使い、
     得られなければ（届かない・その場所に建物データが無い）、**いまの方法（PLATEAUを直接読む）にそのまま戻る**。これはユーザーの決定事項。
   - どの出所の高さかを内部の記録（診断）に残す。画面の文言には内部の構成を出さない。
   - 既存の屋根の結果の保存（`readRoofPersistentCache`）と矛盾しないよう、保存の鍵に出所を含めるか、保存しないかを決めて理由を書く。
4. **テスト**: `tools/plateau-building-ingest/fixtures/` の実物2ファイルから作った保存データで、
   点→建物→高さの照合（LOD1の箱、LOD2の傾いた屋根、穴のある面、建物の外の点、複数データセットの優先）を確かめる。

第3段階で決める前にユーザーへ確認が要る点:
- **LOD1しか無い建物の高さの扱い。** `ht`（`uro:lod1HeightType`）が「中央値」などの場合、箱の上面は屋根の最高点ではない。
  精度最優先の方針上、「LOD1の箱の高さ」を「屋根の最高点」と同じものとして黙って使わないこと。
  コード表（PLATEAUの `Building_lod1HeightType.xml`）で意味を確認し、扱いの案を出して確認を取る。
- **付属物（`zi`/`ti`）を被写体の高さに含めるか。**
- **`special` の4データセットを使うか。**

### 手順D: 実機での確認（第4段階）

ユーザーが更新版を入れ、高さが分かっている建物（東京タワー周辺など、`LandmarkHeightAuditPanel` の対象）で、
新しい口の答えと、いままでの方法の答えを比べる。こちらでは実機・実データの確認はできないので、未確認と明記して渡す。

## 4. 未決定のまま残っていること（勝手に決めない）

1. **Google 3D の形状を高さとして読んでいる箇所をやめるか。** 設計方針（Googleの3Dを測量値として使わない）と食い違っているが、
   少なくとも4か所で読んでいる（`src/cesium/highestPrecision.ts` の三脚候補、3Dタップ、被写体の明示クランプ、スポット検索の三脚クランプ）。未変更。
2. **PLATEAUが無い場所の高さの出し方。** 提案済みの順（PLATEAU → 県のLiDAR表面データ → 既知の高さ → OSM → 地面のピン＋注意／手入力）は未承認。
3. **「遅い」件の調査の続き。** 合意した順番は ⑦上部プレビュー → ②時間軸 → ⑥3Dマップ → ③2D地図。④ピン設置は対応済み。
   「次は⑦の調査に進む」と伝えたところで、PLATEAUの話に移った。
4. 大気差の係数 k=0.13、粗い走査の30m間隔は、そのままにしてある。

## 5. このセッションで入った主な変更（詳細は各テスト名を参照）

- 監査での不具合修正一式、内部構成を示す文言・識別子の除去、エラーの「詳細をコピー」ボタン。
- 自由ビューモード（3Dマップ全画面・時間軸スライダー・天体選択・スポット検索・戻る。指のスライドで向きを変える）。
- 三脚候補の探索を1mデータで行うよう修正（候補0件の不具合）、地点ごとのジオイド、保存断面による近道の停止。
- 上部プレビューの読み込み中の表示改善、ピン設置中の仮ピン。
- PLATEAUの調査の道具2つ（`tools/plateau-size-survey/`）と取り込みの道具（`tools/plateau-building-ingest/`）。
  いずれもアプリ本体のコードは変えていない。

## 6. 作業環境の注意

- 取り込みの道具は Node.js だけで動く（追加のパッケージ不要）。`fetch` と `zlib` を使う。
- 配布元は2つ（`assets.cms.plateau.reearth.io`、`gsic-opendata.s3.ap-northeast-1.amazonaws.com`）。どちらも部分取得に応じることを実測済み。
- 出典の表示が必要（3D都市モデル（Project PLATEAU）国土交通省）。アプリ内の既存の出典表示に不足が無いか確認する。
