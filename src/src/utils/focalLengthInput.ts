import {
  FOCAL_LENGTH_MAX,
  FOCAL_LENGTH_MIN,
} from "../types/camera.ts";

export type FocalLengthInputResult =
  | { valid: true; value: number }
  | { valid: false };

function normalizeNumericCharacters(input: string): string {
  return input
    .trim()
    .replace(/[０-９]/gu, (character) =>
      String(character.charCodeAt(0) - "０".charCodeAt(0))
    )
    .replaceAll("．", ".")
    .replaceAll("－", "-")
    .replaceAll("−", "-")
    .replaceAll("＋", "+");
}

/**
 * 入力途中は文字列のまま保持し、確定時だけ撮影計算へ渡せる値かを検証する。
 * これにより、既存値を消してから「40」「50」などを入力できる。
 */
export function parseFocalLengthInput(
  input: string
): FocalLengthInputResult {
  const normalized = normalizeNumericCharacters(input);
  if (normalized.length === 0) return { valid: false };

  const value = Number(normalized);
  if (
    !Number.isFinite(value) ||
    value < FOCAL_LENGTH_MIN ||
    value > FOCAL_LENGTH_MAX
  ) {
    return { valid: false };
  }

  return { valid: true, value };
}
