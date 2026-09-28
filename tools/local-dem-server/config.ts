import path from "node:path";

export type LocalDemServerConfig = {
  host: "127.0.0.1";
  port: number;
  dataRoot: string;
  originToken: string;
  maximumBodyBytes: number;
  maximumPoints: number;
  requestTimeoutMs: number;
  maximumConcurrentRequests: number;
  maximumQueuedRequests: number;
};

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range`);
  }
  return value;
}

function optionalSecret(
  environment: NodeJS.ProcessEnv,
  name: string,
  minimumLength: number
): string | undefined {
  const value = environment[name]?.trim();
  if (!value) return undefined;
  if (Buffer.byteLength(value, "utf8") < minimumLength) {
    throw new Error(`${name} is too short`);
  }
  return value;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env
): LocalDemServerConfig {
  const configuredHost = environment.LOCAL_DEM_HOST?.trim() || "127.0.0.1";
  // cloudflared connects to this loopback listener. Refuse configuration that
  // could expose the service on a LAN or public interface.
  if (configuredHost !== "127.0.0.1") {
    throw new Error("LOCAL_DEM_HOST must be 127.0.0.1");
  }

  const configuredRoot = environment.LOCAL_DEM_DATA_ROOT?.trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error("LOCAL_DEM_DATA_ROOT must be an absolute path");
  }

  const originToken = optionalSecret(environment, "LOCAL_DEM_ORIGIN_TOKEN", 32);
  if (!originToken) {
    throw new Error("LOCAL_DEM_ORIGIN_TOKEN is required");
  }

  return {
    host: "127.0.0.1",
    port: integerEnvironment(environment, "LOCAL_DEM_PORT", 8789, 1024, 65_535),
    dataRoot: path.resolve(configuredRoot),
    originToken,
    maximumBodyBytes: integerEnvironment(
      environment,
      "LOCAL_DEM_MAX_BODY_BYTES",
      131_072,
      4_096,
      1_048_576
    ),
    maximumPoints: integerEnvironment(environment, "LOCAL_DEM_MAX_POINTS", 512, 1, 2_048),
    requestTimeoutMs: integerEnvironment(
      environment,
      "LOCAL_DEM_REQUEST_TIMEOUT_MS",
      12_000,
      250,
      30_000
    ),
    maximumConcurrentRequests: integerEnvironment(
      environment,
      "LOCAL_DEM_MAX_CONCURRENT_REQUESTS",
      2,
      1,
      8
    ),
    maximumQueuedRequests: integerEnvironment(
      environment,
      "LOCAL_DEM_MAX_QUEUED_REQUESTS",
      8,
      0,
      64
    ),
  };
}
