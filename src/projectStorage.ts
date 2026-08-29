import type { PlannerProject } from "./types/project";
import type { GroundPoint } from "./types/points";
import { publishUserNotice } from "./errors/userFeedback";

const KEY = "ksg-planner-projects-v1";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidLatitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -180 && value <= 180;
}

function isValidGroundPoint(value: unknown): value is GroundPoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Partial<GroundPoint>;
  return isValidLatitude(point.latitude) &&
    isValidLongitude(point.longitude) &&
    isFiniteNumber(point.height) &&
    typeof point.label === "string";
}

/**
 * 保存済みプロジェクトの完全性を検証する。以前はid/name/date/緯度程度しか
 * 見ておらず、longitude・height・timeZone・cameraSettings等が壊れた
 * データでも型上は通ってしまっていた（B-03）。読み込んだ値をそのまま
 * Cesiumへ渡す前提の全フィールドを検証する。
 */
function isValidPlannerProject(value: unknown): value is PlannerProject {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Partial<PlannerProject>;

  if (typeof project.id !== "string" || project.id.length === 0) return false;
  if (typeof project.name !== "string") return false;
  if (typeof project.shootingDateTimeLocal !== "string" ||
    Number.isNaN(new Date(project.shootingDateTimeLocal).getTime())) {
    return false;
  }
  if (typeof project.timeZone !== "string" || project.timeZone.length === 0) return false;
  if (typeof project.calendarRegistered !== "boolean") return false;

  if (!isValidGroundPoint(project.subject)) return false;
  if (!isValidGroundPoint(project.tripod)) return false;

  if (!Array.isArray(project.foregroundObjects)) return false;
  for (const object of project.foregroundObjects) {
    if (typeof object !== "object" || object === null) return false;
    const foreground = object as Record<string, unknown>;
    if (!isValidLatitude(foreground.latitude) || !isValidLongitude(foreground.longitude)) {
      return false;
    }
    if (!isFiniteNumber(foreground.heightCm)) return false;
    if (typeof foreground.enabled !== "boolean") return false;
  }

  const cameraSettings = project.cameraSettings as Partial<PlannerProject["cameraSettings"]> | undefined;
  if (!cameraSettings ||
    !isFiniteNumber(cameraSettings.focalLengthMm) ||
    !isFiniteNumber(cameraSettings.lensCenterHeightMeters)) {
    return false;
  }

  const visibility = project.celestialVisibility as Partial<PlannerProject["celestialVisibility"]> | undefined;
  if (!visibility ||
    typeof visibility.sun !== "boolean" ||
    typeof visibility.moon !== "boolean" ||
    typeof visibility.milkyWay !== "boolean" ||
    typeof visibility.polaris !== "boolean") {
    return false;
  }

  if (
    project.previewFrameMode !== "screen" &&
    project.previewFrameMode !== "landscape-3-2" &&
    project.previewFrameMode !== "portrait-3-2"
  ) return false;
  if (project.mapViewMode !== "2d" && project.mapViewMode !== "3d") return false;
  if (!isFiniteNumber(project.mapZoom)) return false;

  const mapCenter = project.mapCenter as Partial<PlannerProject["mapCenter"]> | undefined;
  if (!mapCenter || !isValidLatitude(mapCenter.latitude) || !isValidLongitude(mapCenter.longitude)) {
    return false;
  }

  const displaySettings = project.displaySettings as Partial<PlannerProject["displaySettings"]> | undefined;
  if (!displaySettings || typeof displaySettings.celestialMenuOpen !== "boolean") return false;

  return true;
}

export function loadProjects(): PlannerProject[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidPlannerProject);
    if (valid.length !== parsed.length) {
      console.warn(
        `破損した撮影計画データを${parsed.length - valid.length}件スキップしました`
      );
    }
    return valid;
  } catch {
    return [];
  }
}

export function saveProjects(projects: PlannerProject[]): PlannerProject[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(projects));
    return projects;
  } catch (error) {
    // QuotaExceededErrorやプライベートブラウズ時の書き込み拒否で
    // アプリ全体を停止させない。保存前の永続データを返す。
    console.error("プロジェクトを端末へ保存できませんでした", error);
    publishUserNotice({
      key: "project-storage-failed",
      tone: "error",
      message: "撮影計画を端末へ保存できませんでした。空き容量やブラウザの保存設定を確認してください。変更前の保存内容は残っています。",
    });
    return loadProjects();
  }
}

export function upsertProject(project: PlannerProject): PlannerProject[] {
  const current = loadProjects();
  return saveProjects([project, ...current.filter((item) => item.id !== project.id)].slice(0, 500));
}

export function deleteProject(id: string): PlannerProject[] {
  return saveProjects(loadProjects().filter((item) => item.id !== id));
}

/**
 * プロジェクト1件が端末のストレージ上でどれだけの容量を占めるかの概算。
 * JSON文字列のUTF-8バイト数で計算する（日本語のプロジェクト名等は
 * UTF-16の文字数と実際のバイト数が異なるため、TextEncoderで正確に測る）。
 * 個々のプロジェクトはどれも1〜2KB程度で大差が付きにくいが、件数が
 * 数百〜数千に積み重なると無視できない容量になるため、一覧画面での
 * 整理の目安として使う。
 */
export function estimateProjectByteSize(project: PlannerProject): number {
  return new TextEncoder().encode(JSON.stringify(project)).length;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
