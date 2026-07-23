import type { FieldCorrection, GuidancePlan } from "../types/guidance";
import {
  cameraAltitudeToSubjectDegrees,
  guidanceBearingDegrees,
  offsetGroundPoint,
} from "./geometry";

const SAVED_PLAN_KEY = "ksg-saved-compositions-v1";
const FIELD_CORRECTION_KEY = "ksg-field-corrections-v1";

function readArray<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export function loadSavedGuidancePlans(): GuidancePlan[] {
  return readArray<GuidancePlan>(SAVED_PLAN_KEY).filter((plan) =>
    typeof plan.id === "string" &&
    typeof plan.title === "string" &&
    typeof plan.tripod?.latitude === "number" &&
    typeof plan.subject?.latitude === "number"
  );
}

export function saveGuidancePlan(plan: GuidancePlan): GuidancePlan[] {
  const current = loadSavedGuidancePlans();
  const next = [plan, ...current.filter((item) => item.id !== plan.id)].slice(0, 100);
  localStorage.setItem(SAVED_PLAN_KEY, JSON.stringify(next));
  return next;
}

export function loadFieldCorrections(): FieldCorrection[] {
  return readArray<FieldCorrection>(FIELD_CORRECTION_KEY).filter((correction) =>
    typeof correction.planId === "string" &&
    typeof correction.eastOffsetMeters === "number" &&
    typeof correction.northOffsetMeters === "number"
  );
}

export function saveFieldCorrection(correction: FieldCorrection): FieldCorrection[] {
  const current = loadFieldCorrections();
  const next = [
    correction,
    ...current.filter((item) =>
      item.planId !== correction.planId && item.spotKey !== correction.spotKey
    ),
  ].slice(0, 200);
  localStorage.setItem(FIELD_CORRECTION_KEY, JSON.stringify(next));
  return next;
}

export function planSpotKey(
  plan: Pick<GuidancePlan, "subject" | "celestialId">
): string {
  return [
    plan.subject.latitude.toFixed(5),
    plan.subject.longitude.toFixed(5),
    plan.celestialId,
  ].join(":");
}

export function correctionForPlan(plan: GuidancePlan): FieldCorrection | null {
  const corrections = loadFieldCorrections();
  return corrections.find((item) => item.planId === plan.id) ??
    corrections.find((item) => item.spotKey === planSpotKey(plan)) ?? null;
}

export function applyFieldCorrection(
  plan: GuidancePlan,
  correction: FieldCorrection | null = correctionForPlan(plan)
): GuidancePlan {
  if (!correction) return plan;
  const tripod = offsetGroundPoint(
    plan.calculatedTripod,
    correction.eastOffsetMeters,
    correction.northOffsetMeters,
    correction.elevationCorrectionMeters,
    `${plan.calculatedTripod.label}（現地補正済み）`
  );
  const subjectAzimuthDegrees = guidanceBearingDegrees(tripod, plan.subject);
  const subjectAltitudeDegrees = cameraAltitudeToSubjectDegrees(
    tripod,
    plan.subject,
    correction.lensCenterHeightMeters
  );
  return {
    ...plan,
    tripod,
    lensCenterHeightMeters: correction.lensCenterHeightMeters,
    subjectAzimuthDegrees,
    subjectAltitudeDegrees,
    cameraAzimuthDegrees: subjectAzimuthDegrees + correction.azimuthCorrectionDegrees,
    cameraAltitudeDegrees: subjectAltitudeDegrees + correction.altitudeCorrectionDegrees,
    viewCorrectionAzimuthDegrees: correction.azimuthCorrectionDegrees,
    viewCorrectionAltitudeDegrees: correction.altitudeCorrectionDegrees,
  };
}
