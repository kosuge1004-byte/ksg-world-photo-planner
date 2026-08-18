import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const index = read("index.html");
const cloudflareHeaders = read("public/_headers");
const cloudflareRedirects = read("public/_redirects");
const cloudflareApiResponses = read("functions/_shared/http.ts");

if (!/<meta\s+name=["']robots["']\s+content=["']noindex,\s*nofollow["']\s*\/?>/i.test(index)) {
  throw new Error("index.html does not contain the generic noindex directive");
}
if (!/^\/\*\s*$/m.test(cloudflareHeaders) ||
    !/^\s+X-Robots-Tag:\s*noindex,\s*nofollow\s*$/mi.test(cloudflareHeaders)) {
  throw new Error("Cloudflare _headers does not exclude all static responses from indexing");
}
if (!/SPA/i.test(cloudflareRedirects) ||
    fs.existsSync(new URL("../public/404.html", import.meta.url))) {
  throw new Error("Cloudflare Pages automatic SPA routing is not preserved");
}
if (!/["']X-Robots-Tag["']:\s*["']noindex,\s*nofollow["']/i.test(cloudflareApiResponses)) {
  throw new Error("Cloudflare Pages Functions do not send the noindex response header");
}

const robotsUrl = new URL("../public/robots.txt", import.meta.url);
if (fs.existsSync(robotsUrl) && /^\s*Disallow:\s*\/\s*$/mi.test(fs.readFileSync(robotsUrl, "utf8"))) {
  throw new Error("robots.txt blocks crawling, so compliant crawlers cannot observe noindex");
}

console.log(JSON.stringify({
  htmlRobotsMeta: true,
  cloudflareStaticHeader: true,
  cloudflareApiHeader: true,
  cloudflareSpaRouting: true,
  crawlerCanReadNoindex: true,
}));
