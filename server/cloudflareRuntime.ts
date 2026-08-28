import type { R2MonthlyBudgetDb } from "./r2SafetyBudget.ts";

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

type RuntimeConfiguration = {
  cesiumIonToken?: string;
  persistentCache?: RuntimeKvNamespace;
  waitUntil?: (promise: Promise<unknown>) => void;
  r2WriteBudgetDb?: R2MonthlyBudgetDb;
};

let configuration: RuntimeConfiguration = {};

/** Cloudflare bindingをサーバー計算モジュールへ注入する。 */
export function configureServerRuntime(
  next: RuntimeConfiguration
): void {
  configuration = {
    cesiumIonToken: next.cesiumIonToken?.trim() || undefined,
    persistentCache: next.persistentCache,
    waitUntil: next.waitUntil,
    r2WriteBudgetDb: next.r2WriteBudgetDb,
  };
}

export function serverCesiumIonToken(): string | undefined {
  return configuration.cesiumIonToken;
}

export function serverPersistentCache(): RuntimeKvNamespace | undefined {
  return configuration.persistentCache;
}

export function serverR2WriteBudgetDb(): R2MonthlyBudgetDb | undefined {
  return configuration.r2WriteBudgetDb;
}

export function keepServerTaskAlive(promise: Promise<unknown>): void {
  configuration.waitUntil?.(promise);
}
