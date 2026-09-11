import fs from "node:fs";

// 2026-09-09追記（お気に入り機能の廃止に伴う全面更新）: 元々このテストは
// スポット検索直後に「ダウンロードしてお気に入りに登録」「ダウンロードして
// お気に入りには登録しない」「ダウンロードしない」の3択を出す設計を検証
// していた。「お気に入り」＝「ダウンロード済みデータ」であり別管理する
// 意味がないという判断から、お気に入り機能そのものを廃止し、ダウンロード
// 済みデータの一覧だけに統合した。これに伴い、確認ダイアログは常に
// 「保存する」「保存しない」の2択のみになった。
const app = fs.readFileSync("src/App.tsx", "utf8");
const dialog = fs.readFileSync("src/components/BearingProfileDownloadDialog.tsx", "utf8");
const subjectStorage = fs.readFileSync("src/subjectStorage.ts", "utf8");
const downloadedSpotData = fs.readFileSync("src/cache/downloadedSpotData.ts", "utf8");
const screen = fs.readFileSync("src/components/SpotSearchScreen.tsx", "utf8");

const checks = [
  ["spot search result opens the save-confirmation dialog", app.includes("offerBearingProfileDownload(searchedRecord)")],
  ["dialog offers a plain save choice", dialog.includes('保存する') && dialog.includes('保存しない')],
  ["dialog no longer has the 3-choice favorite branch", !dialog.includes("ダウンロードしてお気に入りに登録") && !dialog.includes("ダウンロードしてお気に入りには登録しない")],
  ["dialog no longer exposes a favorite/spot-search mode", !dialog.includes('mode: "favorite" | "spot-search"') && !dialog.includes("onConfirmAndFavorite")],
  ["favorite storage functions were removed (unified into downloadedSpotData)", !subjectStorage.includes("export function addFavoriteSubject") && !subjectStorage.includes("export function toggleFavoriteSubject")],
  ["downloaded spot data owns rename, taking over the favorite label-edit feature", downloadedSpotData.includes("export function renameDownloadedSpotData")],
  ["pending download stores exact searched point", app.includes("bearingProfilePendingRef = useRef<{ record: SubjectRecord; subjectPoint: GroundPoint; forceRefresh?: boolean } | null>") && app.includes("subjectPoint: downloadPoint")],
  // 2026-09-11追記: バックグラウンド復帰時の自動再試行のためisAutoRetry引数を
  // 追加したが、これはregisterFavoriteの再導入ではない（意図はシグネチャの
  // 完全一致ではなく「registerFavoriteフラグが無いこと」）。
  ["confirm no longer takes a registerFavorite flag", /async function confirmBearingProfileDownload\([^)]*\)\s*\{/.test(app) && !/confirmBearingProfileDownload\([^)]*registerFavorite/.test(app)],
  ["save toggle is driven by downloadedSpotData membership, not a separate favorites list", app.includes("downloadedSpotData.some((item) => item.subjectId === subjectId)")],
  ["screen no longer renders a separate favorites tab", !screen.includes('"favorites"') && !screen.includes("お気に入りを表示")],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
