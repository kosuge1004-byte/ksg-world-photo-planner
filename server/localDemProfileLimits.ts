/**
 * Local DEM exact-profile request limits shared by the browser client and the
 * private E-drive service. Keeping the calculation in one module prevents the
 * two sides from silently accepting different batch sizes.
 */
export const LOCAL_DEM_NATIONWIDE_MAX_BEARINGS = 120;
export const LOCAL_DEM_LEGACY_MAX_BEARINGS = 24;

const LOCAL_DEM_NATIONWIDE_WORK_BUDGET_METERS = 1_200_000;
const LOCAL_DEM_LEGACY_WORK_BUDGET_METERS = 240_000;

export function localDemExactBearingBatchLimit(
  maxDistanceMeters: number,
  nationwideDemReady: boolean
): number {
  if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0) return 1;
  const maximumBearings = nationwideDemReady
    ? LOCAL_DEM_NATIONWIDE_MAX_BEARINGS
    : LOCAL_DEM_LEGACY_MAX_BEARINGS;
  const workBudgetMeters = nationwideDemReady
    ? LOCAL_DEM_NATIONWIDE_WORK_BUDGET_METERS
    : LOCAL_DEM_LEGACY_WORK_BUDGET_METERS;
  return Math.max(
    1,
    Math.min(maximumBearings, Math.floor(workBudgetMeters / maxDistanceMeters))
  );
}
