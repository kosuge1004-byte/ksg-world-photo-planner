import {
  getGsiDecodedTileForClient,
  type GsiElevationSource,
} from "../../server/gsiElevation.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";

const VALID_SOURCES = new Set<GsiElevationSource>([
  "DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B",
]);

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "GETリクエストのみ利用できます" }, 405, "no-store");
  }
  configureCloudflareServerRuntime(context);
  const url = new URL(context.request.url);
  const sourceValue = url.searchParams.get("source") as GsiElevationSource | null;
  const x = Number(url.searchParams.get("x"));
  const y = Number(url.searchParams.get("y"));
  if (!sourceValue || !VALID_SOURCES.has(sourceValue) || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    return jsonResponse({ error: "DEMタイル指定が不正です" }, 400, "no-store");
  }
  const tile = await getGsiDecodedTileForClient(sourceValue, x, y, context.request.signal);
  if (!tile) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  }
  const bytes = new ArrayBuffer(tile.heightsCentimeters.length * 4);
  const view = new DataView(bytes);
  for (let index = 0; index < tile.heightsCentimeters.length; index += 1) {
    view.setInt32(index * 4, tile.heightsCentimeters[index], true);
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=86400",
      "X-AstroSight-DEM-Width": String(tile.width),
      "X-AstroSight-DEM-Height": String(tile.height),
      "X-Content-Type-Options": "nosniff",
    },
  });
};
