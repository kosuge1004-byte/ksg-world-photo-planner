import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS,
  quickTunnelElevationEndpoint,
} from "../../server/localDemEndpointRegistry.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const localServerEntry = path.join(directory, "server.ts");
const originToken = process.env.LOCAL_DEM_ORIGIN_TOKEN?.trim() ?? "";
const registrationToken = process.env.LOCAL_DEM_REGISTRATION_TOKEN?.trim() ?? "";
const port = Number(process.env.LOCAL_DEM_PORT ?? "8789");
const cloudflared = process.env.LOCAL_DEM_CLOUDFLARED_PATH?.trim() || "cloudflared";
const registrationUrl = new URL(
  process.env.ASTROSIGHT_LOCAL_DEM_REGISTER_URL?.trim() ||
    "https://astrosight.pages.dev/api/local-dem-register"
);

if (originToken.length < 32 || registrationToken.length < 32) {
  throw new Error("LOCAL_DEM_ORIGIN_TOKEN and LOCAL_DEM_REGISTRATION_TOKEN are required");
}
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error("LOCAL_DEM_PORT is invalid");
}
if (registrationUrl.protocol !== "https:" || registrationUrl.username ||
  registrationUrl.password || registrationUrl.search || registrationUrl.hash ||
  registrationUrl.port || registrationUrl.hostname !== "astrosight.pages.dev" ||
  registrationUrl.pathname !== "/api/local-dem-register") {
  throw new Error("ASTROSIGHT_LOCAL_DEM_REGISTER_URL is invalid");
}

let stopping = false;
let localServer: ChildProcess | null = null;
let tunnel: ChildProcess | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let registrationRetry: ReturnType<typeof setTimeout> | null = null;
let activeQuickTunnelUrl: string | null = null;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function registerQuickTunnel(url: string): Promise<void> {
  if (!quickTunnelElevationEndpoint(url)) {
    throw new Error("cloudflared returned an invalid Quick Tunnel URL");
  }
  const response = await fetch(registrationUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "X-AstroSight-Registration-Token": registrationToken,
    },
    body: JSON.stringify({ url }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    let code = "";
    try {
      const body = await response.json() as { code?: unknown };
      if (typeof body.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(body.code)) {
        code = ` (${body.code})`;
      }
    } catch {
      await response.body?.cancel();
    }
    throw new Error(`Quick Tunnel registration failed with HTTP ${response.status}${code}`);
  }
  const body = await response.json() as { gatewayVerified?: unknown };
  if (body.gatewayVerified !== true) {
    throw new Error("Quick Tunnel registration response did not verify the gateway");
  }
  console.log(`[local-dem] Quick Tunnel heartbeat registered (${registrationUrl.hostname})`);
}

function startHeartbeat(url: string): void {
  activeQuickTunnelUrl = url;
  if (heartbeat) clearInterval(heartbeat);
  if (registrationRetry) clearTimeout(registrationRetry);
  registrationRetry = null;
  const send = async () => {
    if (stopping || activeQuickTunnelUrl !== url) return;
    try {
      await registerQuickTunnel(url);
      if (registrationRetry) clearTimeout(registrationRetry);
      registrationRetry = null;
    } catch (error) {
      console.error(`[local-dem] ${error instanceof Error ? error.message : String(error)}`);
      if (!stopping && activeQuickTunnelUrl === url && !registrationRetry) {
        registrationRetry = setTimeout(() => {
          registrationRetry = null;
          void send();
        }, 30_000);
      }
    }
  };
  void send();
  heartbeat = setInterval(() => void send(), LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS * 1_000);
}

async function waitForLocalServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // The child may still be loading the 201-profile manifest.
    }
    await delay(500);
  }
  throw new Error("local DEM service did not become ready");
}

function startLocalServer(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", localServerEntry], {
    cwd: path.resolve(directory, "../.."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(`[local-dem] local service stopped unexpectedly (${code ?? "signal"})`);
      shutdown(1);
    }
  });
  return child;
}

async function runQuickTunnelOnce(): Promise<void> {
  activeQuickTunnelUrl = null;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (registrationRetry) {
    clearTimeout(registrationRetry);
    registrationRetry = null;
  }
  tunnel = spawn(cloudflared, [
    "tunnel",
    "--no-autoupdate",
    "--url",
    `http://127.0.0.1:${port}`,
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const inspectLine = (line: string) => {
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
    if (match && !activeQuickTunnelUrl) startHeartbeat(match[0]);
    // cloudflared output can contain the public URL but never the two tokens.
    console.log(`[cloudflared] ${line}`);
  };
  if (tunnel.stdout) {
    createInterface({ input: tunnel.stdout }).on("line", inspectLine);
  }
  if (tunnel.stderr) {
    createInterface({ input: tunnel.stderr }).on("line", inspectLine);
  }

  await new Promise<void>((resolve, reject) => {
    tunnel?.once("error", reject);
    tunnel?.once("exit", () => resolve());
  });
  tunnel = null;
}

function shutdown(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (registrationRetry) clearTimeout(registrationRetry);
  registrationRetry = null;
  tunnel?.kill();
  localServer?.kill();
  setTimeout(() => process.exit(exitCode), 250).unref();
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

localServer = startLocalServer();
await waitForLocalServer();
console.log(`[local-dem] local service ready on 127.0.0.1:${port}`);

while (!stopping) {
  try {
    await runQuickTunnelOnce();
  } catch (error) {
    console.error(`[local-dem] ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stopping) {
    console.error("[local-dem] Quick Tunnel stopped; retrying in 5 seconds");
    await delay(5_000);
  }
}
