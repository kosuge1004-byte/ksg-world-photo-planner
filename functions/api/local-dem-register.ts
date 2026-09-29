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
    const endpointKv = context.env.SPOT_SEARCH_JOBS as unknown as LocalDemEndpointRegistry;
    await endpointKv.put(
      LOCAL_DEM_ENDPOINT_REGISTRY_KEY,
      encodeRegisteredLocalDemEndpoint(registration),
      { expirationTtl: LOCAL_DEM_ENDPOINT_TTL_SECONDS }
    );
    return response({
      ok: true,
      expiresAt: registration.expiresAt,
      heartbeatSeconds: LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS,
    });
  } catch (error) {
    return response({ error: errorMessage(error) }, requestErrorStatus(error));
  }
};
