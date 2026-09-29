export type LocalDemEndpointRegistry = {
  get(
    key: string,
    options: { type: "arrayBuffer" }
  ): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { expirationTtl?: number }
  ): Promise<void>;
};

export const LOCAL_DEM_ENDPOINT_REGISTRY_KEY = "local-dem-origin/v1/active";
export const LOCAL_DEM_ENDPOINT_TTL_SECONDS = 15 * 60;
export const LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS = 5 * 60;

type RegisteredLocalDemEndpoint = {
  version: 1;
  endpoint: string;
  expiresAt: string;
};

function isQuickTunnelHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(
    hostname.toLowerCase()
  );
}

/**
 * Accept only the account-less Cloudflare Quick Tunnel origin. The public
 * hostname is random and changes after cloudflared restarts; paths, ports,
 * credentials and query fragments are never accepted from the registering PC.
 */
export function quickTunnelElevationEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !isQuickTunnelHostname(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    url.pathname = "/v1/elevation/batch";
    return url.toString();
  } catch {
    return null;
  }
}

export function isQuickTunnelElevationEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const base = value.endsWith("/v1/elevation/batch")
    ? value.slice(0, -"v1/elevation/batch".length)
    : value;
  return quickTunnelElevationEndpoint(base) === value;
}

export function createRegisteredLocalDemEndpoint(
  quickTunnelUrl: string,
  now = Date.now()
): RegisteredLocalDemEndpoint | null {
  const endpoint = quickTunnelElevationEndpoint(quickTunnelUrl);
  if (!endpoint) return null;
  return {
    version: 1,
    endpoint,
    expiresAt: new Date(now + LOCAL_DEM_ENDPOINT_TTL_SECONDS * 1_000).toISOString(),
  };
}

export function encodeRegisteredLocalDemEndpoint(
  registration: RegisteredLocalDemEndpoint
): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(registration)).buffer;
}

export async function readRegisteredLocalDemEndpoint(
  registry: LocalDemEndpointRegistry,
  now = Date.now()
): Promise<string | null> {
  try {
    const bytes = await registry.get(LOCAL_DEM_ENDPOINT_REGISTRY_KEY, {
      type: "arrayBuffer",
    });
    if (!bytes || bytes.byteLength > 2_048) return null;
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
    if (
      typeof value !== "object" || value === null ||
      !("version" in value) || value.version !== 1 ||
      !("endpoint" in value) || !isQuickTunnelElevationEndpoint(value.endpoint) ||
      !("expiresAt" in value) || typeof value.expiresAt !== "string"
    ) {
      return null;
    }
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return value.endpoint;
  } catch {
    return null;
  }
}
