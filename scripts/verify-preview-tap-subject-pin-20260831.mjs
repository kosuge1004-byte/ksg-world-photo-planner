import fs from "node:fs";

const path = "src/components/PreviewGestureLayer.tsx";
const source = fs.readFileSync(path, "utf8");
const checks = [
  ["normal tap is recorded", /tapStartRef\.current\s*=\s*\{ position: points\[0\], time: performance\.now\(\) \}/],
  ["normal tap invokes subject picker", /else\s+onSubjectTap\?\.\(xPercent, yPercent\)/],
  ["measurement remains higher priority", /else if \(measuring\) onMeasureTap\?\.\(xPercent, yPercent\)/],
  ["explicit subject mode remains highest priority", /if \(subjectPicking\) onSubjectTap\?\.\(xPercent, yPercent\)/],
  ["tap movement threshold exists", /TAP_MAX_MOVEMENT_PX\s*=\s*10/],
  ["tap duration threshold exists", /TAP_MAX_DURATION_MS\s*=\s*400/],
  ["drag waits beyond tap threshold", /distance\(start, points\[0\]\) <= TAP_MAX_MOVEMENT_PX\) return/],
  ["swipe still pans", /onPan\(/],
  ["pinch still changes focal length", /pinchRef\.current[\s\S]*onChangeFocalLength/],
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(source);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`PASS: ${checks.length}/${checks.length} preview tap subject-pin checks`);
