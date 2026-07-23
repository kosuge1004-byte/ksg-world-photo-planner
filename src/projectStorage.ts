import type { PlannerProject } from "./types/project";

const KEY = "ksg-planner-projects-v1";

export function loadProjects(): PlannerProject[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PlannerProject => {
      const project = item as Partial<PlannerProject>;
      return typeof project.id === "string" && typeof project.name === "string" &&
        typeof project.shootingDateTimeLocal === "string" &&
        typeof project.subject?.latitude === "number" &&
        typeof project.tripod?.latitude === "number";
    });
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
