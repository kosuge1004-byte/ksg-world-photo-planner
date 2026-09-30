import {
  createRegisteredLocalDemEndpoint,
  encodeRegisteredLocalDemEndpoint,
  LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS,
  LOCAL_DEM_ENDPOINT_REGISTRY_KEY,
  LOCAL_DEM_ENDPOINT_TTL_SECONDS,
  type LocalDemEndpointRegistry,
} from "../../server/localDemEndpointRegistry.ts";
import {
  errorMessage,
  jsonResponse,
  readJsonRequest,
  requestErrorStatus,
} from "../_shared/http.ts";
import type { CloudflareEnv } from "../_shared/env.ts";

const MAX_REQUEST_BYTES = 1_024;
const TOKEN_HEADER = "X-AstroSight-Registration-Token";
const ORIGIN_TOKEN_HEADER = "X-AstroSight-Origin-Token";
const GATEWAY_VERIFY_TIMEOUT_MS = 8_000;

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function response(value: unknown, status = 200): Response {
  return jsonResponse(value, status, "no-store");
}

async function verifyQuickTunnel(
  elevationEndpoint: string,
  originToken: string
): Promise<{ ok: true } | { ok: false; code: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_VERIFY_TIMEOUT_MS);
  try {
    const healthUrl = new URL("/v1/health", elevationEndpoint);
    const result = await fetch(healthUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        [ORIGIN_TOKEN_HEADER]: originToken,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    await result.body?.cancel();
    if (!result.ok) {
      return { ok: false, code: `ORIGIN_HTTP_${result.status}` };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      code: controller.signal.aborted
        ? "ORIGIN_VERIFY_TIMEOUT"
        : "ORIGIN_UNREACHABLE",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return response({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  const configuredToken = context.env.LOCAL_DEM_REGISTRATION_TOKEN?.trim() ?? "";
  const suppliedToken = context.request.headers.get(TOKEN_HEADER) ?? "";
  if (configuredToken.length < 32 || suppliedToken.length < 32 ||
    !constantTimeEqual(configuredToken, suppliedToken)) {
    return response({ error: "認証できません" }, 401);
  }

  try {
    const body = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
    const registration = createRegisteredLocalDemEndpoint(
      typeof body === "object" && body !== null && "url" in body
        ? body.url as string
        : ""
    );
    if (!registration) {
      return response({ error: "Quick Tunnel URLが不正です" }, 400);
    }
    const originToken = context.env.LOCAL_DEM_ORIGIN_TOKEN?.trim() ?? "";
    if (originToken.length < 32) {
      return response({
        error: "Eドライブ認証secretが未設定です",
        code: "ORIGIN_TOKEN_UNAVAILABLE",
      }, 503);
    }
    // Do not publish a hostname merely because cloudflared printed it. First
    // prove the complete edge-to-origin path and the independent origin token.
    // A failed probe leaves the previous KV record to expire naturally and the
    // PC supervisor retries after 30 seconds.
    const verification = await verifyQuickTunnel(registration.endpoint, originToken);
    if (!verification.ok) {
      return response({
        error: "Quick Tunnelの往復検査に失敗しました",
        code: verification.code,
      }, 503);
    }
    const endpointKv = context.env.SPOT_SEARCH_JOBS as unknown as LocalDemEndpointRegistry;
    await endpointKv.put(
      LOCAL_DEM_ENDPOINT_REGISTRY_KEY,
      encodeRegisteredLocalDemEndpoint(registration),
      { expirationTtl: LOCAL_DEM_ENDPOINT_TTL_SECONDS }
    );
    return response({
      ok: true,
      gatewayVerified: true,
      expiresAt: registration.expiresAt,
      heartbeatSeconds: LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS,
    });
  } catch (error) {
    return response({ error: errorMessage(error) }, requestErrorStatus(error));
  }
};
