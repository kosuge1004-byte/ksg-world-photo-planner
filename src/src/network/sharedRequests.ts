import { createAbortError } from "../utils/runtimeErrors";
import { recordCacheDiagnostic } from "./networkDiagnostics";

const inFlight = new Map<string, Promise<unknown>>();

export function roundedCoordinateKey(value: number, decimals = 5): string {
  if (!Number.isFinite(value)) throw new Error("共有要求キーの座標が不正です");
  return value.toFixed(decimals);
}

export function coordinateRequestKey(
  namespace: string,
  latitude: number,
  longitude: number,
  decimals = 5,
  suffix = ""
): string {
  const base = `${namespace}:${roundedCoordinateKey(latitude, decimals)}:${roundedCoordinateKey(longitude, decimals)}`;
  return suffix ? `${base}:${suffix}` : base;
}

function abortError(): Error {
  return createAbortError("通信を中止しました");
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * 同一キーの未完了要求を一本化する。呼出側のAbortSignalは待機だけを中止し、
 * 他の利用者が共有している基礎通信までは中断しない。
 */
export function shareInFlightRequest<T>(options: {
  key: string;
  category: string;
  signal?: AbortSignal;
  factory: () => Promise<T>;
}): Promise<T> {
  const existing = inFlight.get(options.key) as Promise<T> | undefined;
  if (existing) {
    recordCacheDiagnostic(options.category, options.key, "deduplicated", "shared-in-flight");
    return awaitWithAbort(existing, options.signal);
  }
  const request = Promise.resolve().then(options.factory);
  inFlight.set(options.key, request);
  void request.finally(() => {
    if (inFlight.get(options.key) === request) inFlight.delete(options.key);
  }).catch(() => undefined);
  return awaitWithAbort(request, options.signal);
}

export function clearSharedRequestsForTests(): void {
  inFlight.clear();
}
