import { Cartographic, Math as CesiumMath } from "cesium";

import {
  lookupGsiBridgeSurfaceContexts,
  isBridgeSupportSurfaceSample,
  markBridgeSupportSurfaceSample,
  resolveBridgeDeckOrthometricHeight,
  type GsiBridgeSurfaceContext,
} from "../../server/gsiBridgeSurface.ts";
import {
  deriveTerrainSampleAtHeight,
  geoidHeightMetersForTerrainSample,
  sampleWorldTerrain,
  sampleWorldTerrainNeutral,
} from "./worldTerrain";

type GsiMaximumDetail = "1m" | "5m" | "10m";
type BridgeApproachHeights = {
  startApproachHeightsMeters: number[];
  endApproachHeightsMeters: number[];
};

const MAX_APPROACH_CACHE_ENTRIES = 128;
const bridgeApproachCache = new Map<string, BridgeApproachHeights>();

function rememberApproaches(key: string, value: BridgeApproachHeights): void {
  bridgeApproachCache.delete(key);
  bridgeApproachCache.set(key, value);
  while (bridgeApproachCache.size > MAX_APPROACH_CACHE_ENTRIES) {
    const oldest = bridgeApproachCache.keys().next().value as string | undefined;
    if (!oldest) break;
    bridgeApproachCache.delete(oldest);
  }
}

function orthometricHeight(sample: Cartographic): number | null {
  const geoid = geoidHeightMetersForTerrainSample(sample);
  return Number.isFinite(sample.height) && Number.isFinite(geoid)
    ? sample.height - (geoid as number)
    : null;
}

async function resolveApproaches(
  context: GsiBridgeSurfaceContext,
  signal?: AbortSignal
): Promise<BridgeApproachHeights | null> {
  const cached = bridgeApproachCache.get(context.bridgeKey);
  if (cached) {
    bridgeApproachCache.delete(context.bridgeKey);
    bridgeApproachCache.set(context.bridgeKey, cached);
    return cached;
  }
  const coordinates = [...context.startOutsidePoints, ...context.endOutsidePoints];
  try {
    const samples = await sampleWorldTerrainNeutral(
      coordinates.map((point) => Cartographic.fromDegrees(point.longitude, point.latitude, 0)),
      signal,
      "1m",
      { allowWorldTerrainFallback: false }
    );
    const heights = samples.map(orthometricHeight);
    const start = heights.slice(0, context.startOutsidePoints.length).filter(
      (height): height is number => height !== null
    );
    const end = heights.slice(context.startOutsidePoints.length).filter(
      (height): height is number => height !== null
    );
    if (start.length === 0 || end.length === 0) return null;
    const resolved = {
      startApproachHeightsMeters: start,
      endApproachHeightsMeters: end,
    };
    rememberApproaches(context.bridgeKey, resolved);
    return resolved;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
}

/**
 * Samples the normal terrain first, then replaces only GSI-classified bridge
 * coordinates whose DEM does not already represent the deck. The replacement
 * is based on the two road approaches and is shared by the exact candidate
 * point calculation and its red terrain line.
 */
export async function sampleTripodSupportSurface(
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetail?: GsiMaximumDetail
): Promise<Cartographic[]> {
  const base = await sampleWorldTerrain(points, signal, maximumDetail);
  if (base.length === 0 || signal?.aborted) return base;
  const contexts = await lookupGsiBridgeSurfaceContexts(
    base.map((sample) => ({
      latitude: CesiumMath.toDegrees(sample.latitude),
      longitude: CesiumMath.toDegrees(sample.longitude),
    })),
    signal
  );
  if (!contexts) return base;

  const approachesByKey = new Map<string, BridgeApproachHeights | null>();
  await Promise.all([...new Map(
    contexts.filter((context): context is GsiBridgeSurfaceContext => context !== null)
      .map((context) => [context.bridgeKey, context])
  ).values()].map(async (context) => {
    approachesByKey.set(context.bridgeKey, await resolveApproaches(context, signal));
  }));

  return base.map((sample, index) => {
    const context = contexts[index];
    if (!context) return sample;
    const approaches = approachesByKey.get(context.bridgeKey);
    const geoid = geoidHeightMetersForTerrainSample(sample);
    if (!approaches || !Number.isFinite(sample.height) || !Number.isFinite(geoid)) return sample;
    const existingOrthometric = sample.height - (geoid as number);
    const deckOrthometric = resolveBridgeDeckOrthometricHeight({
      existingHeightMeters: existingOrthometric,
      ...approaches,
      positionFraction: context.positionFraction,
    });
    if (deckOrthometric === null) return sample;
    if (deckOrthometric === existingOrthometric) {
      markBridgeSupportSurfaceSample(sample);
      return sample;
    }
    const derived = deriveTerrainSampleAtHeight(sample, deckOrthometric + (geoid as number));
    markBridgeSupportSurfaceSample(derived);
    return derived;
  });
}

export { isBridgeSupportSurfaceSample };

export function clearBridgeApproachCacheForTests(): void {
  bridgeApproachCache.clear();
}
