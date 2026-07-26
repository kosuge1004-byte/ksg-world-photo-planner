import { getStore } from "@netlify/blobs";

import type {
  SpotSearchJob,
  SpotSearchJobInput,
} from "../src/types/backgroundSearch.ts";

const STORE_NAME = "ksg-spot-search-jobs-v1";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validSearchJobId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function validSpotSearchJobInput(
  value: unknown
): value is SpotSearchJobInput {
  if (typeof value !== "object" || value === null) return false;
  if (!("criteria" in value) || typeof value.criteria !== "object" || value.criteria === null) {
    return false;
  }
  if (!("subject" in value) || typeof value.subject !== "object" || value.subject === null) {
    return false;
  }
  return "baseDateIso" in value && typeof value.baseDateIso === "string" &&
    Number.isFinite(Date.parse(value.baseDateIso)) &&
    "timeZone" in value && typeof value.timeZone === "string" && value.timeZone.length <= 80 &&
    "lensCenterHeightMeters" in value && Number.isFinite(value.lensCenterHeightMeters) &&
    "subjectGroundHeightMeters" in value && Number.isFinite(value.subjectGroundHeightMeters) &&
    "calculationMode" in value &&
      (value.calculationMode === "standard" || value.calculationMode === "pro");
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function key(clientId: string, jobId: string): string {
  if (!validSearchJobId(clientId) || !validSearchJobId(jobId)) {
    throw new Error("検索ジョブIDが不正です");
  }
  return `${clientId}/${jobId}.json`;
}

function isSpotSearchJob(value: unknown): value is SpotSearchJob {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "clientId" in value && validSearchJobId(value.clientId) &&
    "jobId" in value && validSearchJobId(value.jobId) &&
    "status" in value && typeof value.status === "string" &&
    "input" in value && typeof value.input === "object" && value.input !== null &&
    "results" in value && Array.isArray(value.results);
}

export async function getSpotSearchJob(
  clientId: string,
  jobId: string
): Promise<SpotSearchJob | null> {
  const value = await store().get(key(clientId, jobId), { type: "json" }) as unknown;
  return isSpotSearchJob(value) ? value : null;
}

export async function setSpotSearchJob(job: SpotSearchJob): Promise<void> {
  await store().setJSON(key(job.clientId, job.jobId), job, {
    metadata: { status: job.status, updatedAt: job.updatedAt },
  });
}

export async function updateSpotSearchJob(
  clientId: string,
  jobId: string,
  update: Partial<Pick<SpotSearchJob, "status" | "progress" | "progressPercent" | "results" | "error">>
): Promise<SpotSearchJob> {
  const current = await getSpotSearchJob(clientId, jobId);
  if (!current) throw new Error("検索ジョブが見つかりません");
  const next: SpotSearchJob = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  await setSpotSearchJob(next);
  return next;
}
