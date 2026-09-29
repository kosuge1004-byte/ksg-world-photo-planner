# 登録スポット（ランドマーク）データの記述ルール

対象: `server/landmarkPrewarmSeed.ts` と `src/data/japanLandmarks.ts`（同一内容を保つ）

## 必須項目
すべての地点に、被写体をどこに置くか（`subjectSurface`）と高さ（`heightMeters`）を書く。

| 種類 | 書き方 | 意味 |
|---|---|---|
| 地表 | `subjectSurface: "terrain", heightMeters: 0` | 被写体はDEM地表そのもの（山頂・テーマパーク・城跡など） |
| 構造物 | `subjectSurface: "structure", heightMeters: 634` | 登録座標の地表から頂上までの高さ(m)。1.5〜700m |

- 高さは「海抜標高」ではなく「地表からの高さ」で書く。地表の標高は計算時に
  GSI DEMとJPGEO2024から地点ごとに求めるため、標高を重複して持つと食い違う。
- 座標は構造物の頂上（塔の中心、天守の中心など）を指すこと。被写体は
  「登録座標＋高さ」で配置し、計算済み三脚候補データもこの座標で作る。
- 高さは出典（公式サイト、自治体資料、Wikipedia等）を確認した値だけを書く。
- 天守・建物が現存しない城跡や史跡は「地表」にする。

## 強制の仕組み
- 型（`src/types/landmarkSubjectSpec.ts`）: 項目が欠けている、地表に0以外の高さ、
  構造物に高さなし、などはビルド時に型エラーになる。
- 回帰テスト（`tests/regression/landmark-subject-spec.test.mjs`）:
  - 両ファイルの名称・座標・仕様が完全一致すること
  - 山・テーマパークは地表、塔・建物・観覧車は構造物であること
  - 構造物の高さが1.5〜700mであること
  - 高さ未確認（`heightMeters: null, heightStatus: "unverified"`）は
    `tests/regression/fixtures/landmark-height-unverified-allowlist.json` にある
    既存113件だけ許可。新規追加は不可、解決したらリストから削除する（減る一方）。

## 計算済み三脚候補データとの関係
登録座標を変更した地点は、R2の計算済みデータ（座標7桁キー）を作り直すまで
直接取得（遅い経路）になる。座標変更時は事前計算とR2公開もやり直すこと。

## スポットを追加するときの手順
1. Google Places等で座標を確認し、`server/landmarkPrewarmSeed.ts` と
   `src/data/japanLandmarks.ts` の同じ位置に同じ内容で追加する
   （アプリ側だけ別名 `aliases` を付けてよい）。出典をコメントに残す。
2. `subjectSurface` と `heightMeters` を必ず書く（上表）。新しい分類を作る場合は
   両ファイルの `category` 型と、`landmark-subject-spec.test.mjs` の
   分類ごとの必須仕様に追加する。
3. `dem/gsi-landmark-dem-*-manifest.*` に地点を反映する
   （`node scripts/prepare-landmark-dem-manifest.mjs`、国土地理院APIに接続できる環境で）。
4. 計算済み三脚候補データを作る場合は、事前計算→監査→R2公開のあと
   `server/precomputedBearingProfileTargets.ts` に追加する。それまでは
   「計算済みデータなし」と表示して精密な直接取得になる（エラーにはならない）。
5. `npm run build` と `npm test` が通ることを確認する。

## 高さ未確認の構造物をPLATEAU＋DEMで実測する手順
1. アプリを `#landmark-height-audit` 付きのURLで開く（例: `https://astrosight.pages.dev/#landmark-height-audit`）。
   高さ未確認の構造物を順に、PLATEAU全国建物3D Tilesの頂上と、登録座標のGSI DEM地表（JPGEO2024で楕円体高化）
   から実測する。アプリ本体と同じ関数を使うため、天守台がDEMに含まれていても二重計上にならない。
2. 完了後「JSONをコピー」でファイル（例: audit.json）に保存する。
3. `npx tsx scripts/apply-landmark-height-audit.mjs audit.json` で判定を確認し、
   問題なければ `--write` を付けて反映する。頂上が登録座標から30m超離れている（隣の別建物の疑い）、
   高さが3〜120mの範囲外、PLATEAUに建物が無い、実測後に座標が変わった、のいずれかは自動で不採用。
4. `npm test` と `npm run build` を通す。不採用になった地点は、自治体資料等で確認して手で登録する。
