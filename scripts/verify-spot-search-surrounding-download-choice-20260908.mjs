import fs from "node:fs";

const app = fs.readFileSync("src/App.tsx", "utf8");
const dialog = fs.readFileSync("src/components/BearingProfileDownloadDialog.tsx", "utf8");
const storage = fs.readFileSync("src/subjectStorage.ts", "utf8");

const checks = [
  ["spot search result opens surrounding-data choice", app.includes("offerSpotSearchBearingProfileDownload(searchedRecord, pinned)")],
  ["download-only path exists", dialog.includes("ダウンロードしてお気に入りには登録しない")],
  ["download-and-favorite path exists", dialog.includes("ダウンロードしてお気に入りに登録")],
  ["no-download path exists", dialog.includes("ダウンロードしない")],
  ["download-only does not implicitly favorite", app.includes("onConfirm={() => void confirmBearingProfileDownload(false)}")],
  ["download-and-favorite explicitly favorites", app.includes("onConfirmAndFavorite={() => void confirmBearingProfileDownload(true)}")],
  ["favorite add is idempotent", storage.includes("export function addFavoriteSubject") && storage.includes("if (current.some((item) => sameLocation(item, point))) return current;")],
  ["pending download stores exact searched point", app.includes("bearingProfilePendingRef = useRef<{ record: SubjectRecord; subjectPoint: GroundPoint; forceRefresh?: boolean } | null>") && app.includes("subjectPoint: downloadPoint")],
  ["spot dialog has explicit mode", dialog.includes('mode: "favorite" | "spot-search"')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
