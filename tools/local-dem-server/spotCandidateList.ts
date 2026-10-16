/**
 * 2026-10-16: 自動登録スポット（Dynamic Spot）を、後で内蔵スポットへ一括登録する
 * ための「登録スポット候補」一覧として、月ごとのテキストファイルに書き出す。
 *
 * 置き場所: 自動登録スポットの保存先（dynamic-spots-v1）と同じ階層の
 *   「登録スポット候補」フォルダ
 *   例) E:\AstroSight-GSI-data-20260926\登録スポット候補\登録スポット202610一覧.txt
 * 何月に入るか: 最初に登録された日時（createdAt）の日本時間の年月。
 * 中身: 1地点ごとの箇条書き。毎回、登録データ全体からその月の分を作り直すので、
 *   高さが後で確認・更新された場合も反映され、同じ地点が2回並ぶことはない。
 * 文字コード: UTF-8（BOM付き）、改行はCRLF（Windowsのメモ帳でそのまま開ける）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DynamicSpotRecord } from "../../src/types/dynamicSpot.ts";

export const SPOT_CANDIDATE_DIRECTORY = "登録スポット候補";

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

const CATEGORY_LABELS: Record<string, string> = {
  mountain: "山",
  natural: "自然",
  castle: "城",
  themepark: "テーマパーク",
  building: "建物",
  tower: "塔",
  temple: "寺社",
  ferriswheel: "観覧車",
  rollercoaster: "ジェットコースター",
  unknown: "不明",
};

const HEIGHT_STATUS_LABELS: Record<DynamicSpotRecord["heightStatus"], string> = {
  verified: "確認済み",
  measured: "実測",
  estimated: "推定",
  unknown: "不明",
};

const HEIGHT_SOURCE_LABELS: Record<DynamicSpotRecord["heightSourceType"], string> = {
  official: "公式",
  "plateau-measured": "PLATEAU実測",
  "osm-height": "OpenStreetMapの高さ",
  "osm-levels-estimate": "OpenStreetMapの階数から推定",
  unknown: "不明",
};

/** 候補一覧のフォルダ（自動登録スポットの保存先と同じ階層）。 */
export function spotCandidateDirectory(dynamicSpotRoot: string): string {
  return path.resolve(dynamicSpotRoot, "..", SPOT_CANDIDATE_DIRECTORY);
}

function jstParts(iso: string): { year: number; month: number; text: string } | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const shifted = new Date(time + JST_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  return {
    year,
    month,
    text: `${year}-${pad(month)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

/** "202610" のような年月キー（日本時間）。 */
export function spotCandidateMonthKey(record: Pick<DynamicSpotRecord, "createdAt">): string | null {
  const parts = jstParts(record.createdAt);
  return parts ? `${parts.year}${String(parts.month).padStart(2, "0")}` : null;
}

export function spotCandidateFileName(monthKey: string): string {
  return `登録スポット${monthKey}一覧.txt`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}

function heightText(record: DynamicSpotRecord): string {
  if (record.subjectSurface === "terrain") return "0m（地表）";
  if (record.structureHeightMeters === null || record.heightStatus === "unknown") return "不明（要確認）";
  const meters = Math.round(record.structureHeightMeters * 10) / 10;
  return `${meters}m（${HEIGHT_STATUS_LABELS[record.heightStatus]}）`;
}

function sourceText(record: DynamicSpotRecord): string | null {
  if (record.subjectSurface === "terrain") return null;
  const parts = [
    record.heightSourceLabel ? oneLine(record.heightSourceLabel) : null,
    record.heightSourceType !== "unknown" ? `（${HEIGHT_SOURCE_LABELS[record.heightSourceType]}）` : null,
    record.heightSourceUrl ? oneLine(record.heightSourceUrl) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

/** 1か月分の一覧ファイルの本文（BOM・CRLFを付ける前）。 */
export function formatSpotCandidateMonth(monthKey: string, records: readonly DynamicSpotRecord[]): string {
  const year = monthKey.slice(0, 4);
  const month = Number(monthKey.slice(4, 6));
  const sorted = [...records].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.coordinateKey.localeCompare(right.coordinateKey)
  );
  const lines: string[] = [`登録スポット候補 ${year}年${month}月（${sorted.length}件）`, ""];
  for (const record of sorted) {
    const name = oneLine(record.name);
    lines.push(`■ ${name}`);
    lines.push(`・登録日時：${jstParts(record.createdAt)?.text ?? record.createdAt}`);
    const aliases = Array.from(new Set(record.aliases.map(oneLine)))
      .filter((alias) => alias && alias !== name);
    if (aliases.length > 0) lines.push(`・別名：${aliases.join("、")}`);
    lines.push(`・座標：${record.latitude.toFixed(7)}, ${record.longitude.toFixed(7)}`);
    const category = CATEGORY_LABELS[record.category] ?? oneLine(record.category);
    lines.push(`・種類：${category}（${record.subjectSurface === "structure" ? "構造物" : "地表"}）`);
    lines.push(`・高さ：${heightText(record)}`);
    const source = sourceText(record);
    if (source) lines.push(`・高さの出典：${source}`);
    lines.push("");
  }
  return lines.join("\r\n");
}

/** 年月ごとに分ける。日時が読めない記録は入れない（一覧の年月が決まらないため）。 */
export function groupSpotCandidatesByMonth(
  records: readonly DynamicSpotRecord[]
): Map<string, DynamicSpotRecord[]> {
  const groups = new Map<string, DynamicSpotRecord[]>();
  for (const record of records) {
    const key = spotCandidateMonthKey(record);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return groups;
}

export type SpotCandidateListWriter = {
  /** 全月分を書き直す（起動時）。 */
  writeAll(records: readonly DynamicSpotRecord[]): Promise<void>;
  /** 指定した記録が入る月だけを書き直す（登録・更新時）。 */
  writeMonthOf(changed: DynamicSpotRecord, records: readonly DynamicSpotRecord[]): Promise<void>;
};

export function createSpotCandidateListWriter(dynamicSpotRoot: string): SpotCandidateListWriter {
  const directory = spotCandidateDirectory(dynamicSpotRoot);
  // 生成中は進み具合のたびに記録が更新されるが、一覧の中身は変わらない。
  // 同じ内容なら書き込まない（最後に書いた内容を覚えておく）。
  const lastWritten = new Map<string, string>();
  let queue = Promise.resolve();

  const writeMonth = async (monthKey: string, monthRecords: readonly DynamicSpotRecord[]) => {
    const body = `\uFEFF${formatSpotCandidateMonth(monthKey, monthRecords)}`;
    const filePath = path.join(directory, spotCandidateFileName(monthKey));
    if (lastWritten.get(monthKey) === body) return;
    try {
      if (await readFile(filePath, "utf8") === body) {
        lastWritten.set(monthKey, body);
        return;
      }
    } catch {
      // まだファイルが無い。
    }
    await mkdir(directory, { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, filePath);
    lastWritten.set(monthKey, body);
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task, task);
    return queue;
  };

  return {
    writeAll(records) {
      return enqueue(async () => {
        for (const [monthKey, monthRecords] of groupSpotCandidatesByMonth(records)) {
          await writeMonth(monthKey, monthRecords);
        }
      });
    },
    writeMonthOf(changed, records) {
      return enqueue(async () => {
        const monthKey = spotCandidateMonthKey(changed);
        if (!monthKey) return;
        await writeMonth(monthKey, groupSpotCandidatesByMonth(records).get(monthKey) ?? []);
      });
    },
  };
}
