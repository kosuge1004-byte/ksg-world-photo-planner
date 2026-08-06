/** Browser/Node/Workersで共通利用できる名前付きエラー。DOMException型に依存しない。 */
export function createNamedError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function createAbortError(message = "Aborted"): Error {
  return createNamedError(message, "AbortError");
}

export function createTimeoutError(message: string): Error {
  return createNamedError(message, "TimeoutError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
