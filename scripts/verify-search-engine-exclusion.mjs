import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const index = read("index.html");
const cloudflareHeaders = read("public/_headers");
const netlify = read("netlify.toml");

if (!/<meta\s+name=["']robots["']\s+content=["']noindex,\s*nofollow["']\s*\/?>/i.test(index)) {
  throw new Error("index.html does not contain the generic noindex directive");
}
if (!/^\/\*\s*$/m.test(cloudflareHeaders) ||
    !/^\s+X-Robots-Tag:\s*noindex,\s*nofollow\s*$/mi.test(cloudflareHeaders)) {
  throw new Error("Cloudflare _headers does not exclude all static responses from indexing");
}
if (!/X-Robots-Tag\s*=\s*["']noindex,\s*nofollow["']/i.test(netlify)) {
  throw new Error("Netlify does not send the noindex response header");
}

const robotsUrl = new URL("../public/robots.txt", import.meta.url);
if (fs.existsSync(robotsUrl) && /^\s*Disallow:\s*\/\s*$/mi.test(fs.readFileSync(robotsUrl, "utf8"))) {
  throw new Error("robots.txt blocks crawling, so compliant crawlers cannot observe noindex");
}

console.log(JSON.stringify({
  htmlRobotsMeta: true,
  cloudflareStaticHeader: true,
  netlifyResponseHeader: true,
  crawlerCanReadNoindex: true,
}));
