// 実測結果を登録スポットのカタログ文字列へ反映する純粋関数（テスト対象）。
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} source カタログTSファイルの内容
 * @param {Map<string, number>} heights 名前 → heightMeters
 * @returns {{ source: string, applied: string[] }}
 */
export function applyLandmarkHeightsToSource(source, heights) {
  let next = source;
  const applied = [];
  for (const [name, height] of heights) {
    if (!Number.isFinite(height) || height <= 0) throw new Error(`invalid height for ${name}: ${height}`);
    const pattern = new RegExp(
      `(\\{ name: "${escapeRegExp(name)}", category: "\\w+", latitude: -?[\\d.]+, longitude: -?[\\d.]+, )` +
      `subjectSurface: "structure", heightMeters: null, heightStatus: "unverified"`
    );
    const replaced = next.replace(pattern, `$1subjectSurface: "structure", heightMeters: ${Number(height.toFixed(1))}`);
    if (replaced !== next) {
      applied.push(name);
      next = replaced;
    }
  }
  return { source: next, applied };
}
