import { AsyncLocalStorage } from "node:async_hooks";
import type { R2MonthlyBudgetDb } from "./r2SafetyBudget.ts";
import type { LocalDemEndpointRegistry } from "./localDemEndpointRegistry.ts";

export type RuntimeKvNamespace = {
  get(
    key: string,
    options: { type: "arrayBuffer" }
  ): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      expirationTtl?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void>;
  /**
   * Optional diagnostic read used by the DEM path. `bypass` means that R2 was
   * unavailable, rejected by a safety guard, or failed; it must not be reported
   * as a normal cache miss.
   */
  getWithStatus?(
    key: string,
    options: { type: "arrayBuffer" }
  ): Promise<{
    status: "hit" | "miss" | "bypass";
    value: ArrayBuffer | null;
  }>;
};

export type LocalDemGatewayConfiguration = {
  endpoint?: string;
  originToken?: string;
  accessClientId?: string;
  accessClientSecret?: string;
  endpointRegistry?: LocalDemEndpointRegistry;
};

export type RuntimeConfiguration = {
  cesiumIonToken?: string;
  persistentCache?: RuntimeKvNamespace;
  waitUntil?: (promise: Promise<unknown>) => void;
  r2WriteBudgetDb?: R2MonthlyBudgetDb;
  localDemGateway?: LocalDemGatewayConfiguration;
};

const requestRuntime = new AsyncLocalStorage<RuntimeConfiguration>();
let defaultConfiguration: RuntimeConfiguration = {};

function normalizeRuntimeConfiguration(
  next: RuntimeConfiguration
): RuntimeConfiguration {
  return {
    cesiumIonToken: next.cesiumIonToken?.trim() || undefined,
    persistentCache: next.persistentCache,
    waitUntil: next.waitUntil,
    r2WriteBudgetDb: next.r2WriteBudgetDb,
    localDemGateway: {
      endpoint: next.localDemGateway?.endpoint?.trim() || undefined,
      originToken: next.localDemGateway?.originToken?.trim() || undefined,
      accessClientId: next.localDemGateway?.accessClientId?.trim() || undefined,
      accessClientSecret: next.localDemGateway?.accessClientSecret?.trim() || undefined,
      ...(next.localDemGateway?.endpointRegistry
        ? { endpointRegistry: next.localDemGateway.endpointRegistry }
        : {}),
    },
  };
}

function currentConfiguration(): RuntimeConfiguration {
  return requestRuntime.getStore() ?? defaultConfiguration;
}

/** Cloudflare bindingをサーバー計算モジュールへ注入する。 */
export function configureServerRuntime(
  next: RuntimeConfiguration
): void {
  // CLI tools and regression tests run one task at a time and use this default.
  // Cloudflare request handlers must use runWithServerRuntime so concurrent
  // invocations cannot overwrite each other's cache budgets, waitUntil or
  // credentials.
  defaultConfiguration = normalizeRuntimeConfiguration(next);
}

export function runWithServerRuntime<T>(
  next: RuntimeConfiguration,
  task: () => T
): T {
  return requestRuntime.run(normalizeRuntimeConfiguration(next), task);
}

export function serverCesiumIonToken(): string | undefined {
  return currentConfiguration().cesiumIonToken;
}

export function serverPersistentCache(): RuntimeKvNamespace | undefined {
  return currentConfiguration().persistentCache;
}

export function serverR2WriteBudgetDb(): R2MonthlyBudgetDb | undefined {
  return currentConfiguration().r2WriteBudgetDb;
}

export function serverLocalDemGateway(): LocalDemGatewayConfiguration | undefined {
  const gateway = currentConfiguration().localDemGateway;
  if (!gateway?.originToken || (!gateway.endpoint && !gateway.endpointRegistry)) {
    return undefined;
  }
  // Access credentials are an inseparable pair. A named tunnel requires both;
  // a domainless Quick Tunnel deliberately uses neither and relies on the
  // independent origin token plus the short-lived registered hostname.
  if (Boolean(gateway.accessClientId) !== Boolean(gateway.accessClientSecret)) {
    return undefined;
  }
  return gateway;
}

export function keepServerTaskAlive(promise: Promise<unknown>): void {
  currentConfiguration().waitUntil?.(promise);
}
