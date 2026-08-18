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
};

type RuntimeConfiguration = {
  cesiumIonToken?: string;
  persistentCache?: RuntimeKvNamespace;
  waitUntil?: (promise: Promise<unknown>) => void;
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
  };
}

export function serverCesiumIonToken(): string | undefined {
  return configuration.cesiumIonToken;
}

export function serverPersistentCache(): RuntimeKvNamespace | undefined {
  return configuration.persistentCache;
}

export function keepServerTaskAlive(promise: Promise<unknown>): void {
  configuration.waitUntil?.(promise);
}
