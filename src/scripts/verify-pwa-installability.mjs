import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("public/manifest.webmanifest", "utf8"));
const indexHtml = await readFile("index.html", "utf8");
const serviceWorker = await readFile("public/sw.js", "utf8");
const mainSource = await readFile("src/main.tsx", "utf8");
const installSource = await readFile("src/pwa/install.ts", "utf8");
const menuSource = await readFile("src/components/TopSettingsBar.tsx", "utf8");
const headers = await readFile("public/_headers", "utf8");

assert.equal(manifest.id, "/");
assert.equal(manifest.scope, "/");
assert.ok(typeof manifest.name === "string" && manifest.name.length > 0);
assert.ok(typeof manifest.short_name === "string" && manifest.short_name.length > 0);
assert.ok(typeof manifest.start_url === "string" && manifest.start_url.startsWith("/"));
assert.ok(["standalone", "minimal-ui", "fullscreen"].includes(manifest.display));
assert.equal(manifest.prefer_related_applications, false);
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192" && icon.type === "image/png"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.type === "image/png"));

assert.match(indexHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
assert.match(mainSource, /initializePwaInstallSupport\(\)/);
assert.match(installSource, /beforeinstallprompt/);
assert.match(installSource, /navigator\.serviceWorker\.register\("\/sw\.js"/);
assert.match(menuSource, /pwaInstall\.install\(\)/);
assert.match(menuSource, /ホーム画面に追加/);
assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
assert.match(serviceWorker, /request\.mode === "navigate"/);
assert.match(headers, /\/sw\.js[\s\S]*Cache-Control: no-cache/);

console.log("PWA installability contracts: PASS");
