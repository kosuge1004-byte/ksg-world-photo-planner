import { diagnosticFetch } from "./networkDiagnostics";
import { coordinateRequestKey, shareInFlightRequest } from "./sharedRequests";

export async function requestTimeZone(
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<string | null> {
  const key = coordinateRequestKey("timezone", latitude, longitude, 4);
  return shareInFlightRequest({
    key,
    category: "timezone",
    signal,
    factory: async () => {
      const parameters = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
      });
      const response = await diagnosticFetch("timezone", `/api/timezone?${parameters}`);
      const data = (await response.json()) as { timeZone?: unknown };
      return response.ok && typeof data.timeZone === "string" ? data.timeZone : null;
    },
  });
}
