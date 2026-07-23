import type { SiteContext } from "../src/types/geospatial.ts";
import type { GroundPoint } from "../src/types/points.ts";
import { lookupOsmSiteContexts } from "./osmSiteContext.ts";

const MAX_POINTS_PER_REQUEST = 8;

/** Netlify内部から相対HTTP APIを経由せず、同じOSM判定を直接実行する。 */
export async function fetchServerSiteContexts(
  points: GroundPoint[],
  signal?: AbortSignal,
  includeDetails = true
): Promise<SiteContext[]> {
  const contexts: SiteContext[] = [];
  for (let offset = 0; offset < points.length; offset += MAX_POINTS_PER_REQUEST) {
    contexts.push(...await lookupOsmSiteContexts(
      points.slice(offset, offset + MAX_POINTS_PER_REQUEST).map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
      })),
      signal,
      includeDetails
    ));
  }
  return contexts;
}
