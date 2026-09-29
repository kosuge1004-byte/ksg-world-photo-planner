import { useEffect, useRef, useState } from "react";
import type { Viewer } from "cesium";
import { Cartographic } from "cesium";

import {
  acceptLandmarkHeightAuditResult,
  auditLandmarkHeights,
  type LandmarkHeightAuditResult,
} from "../audit/landmarkHeightAudit";
import { ensureHiddenPlateauBuildingsForHeightLookup } from "../cesium/createMapViewer";
import { resolvePlateauRoofGroundPoint } from "../cesium/plateauBuildingVerification";
import { sampleWorldTerrainNeutral } from "../cesium/worldTerrain";
import { JAPAN_LANDMARKS } from "../data/japanLandmarks";
import { resolveGroundPoint } from "../height/heightResolver";

/**
 * 開発用: URLに #landmark-height-audit を付けて開くと、高さ未確認の登録スポットを
 * PLATEAU（全国建物3D Tiles）とGSI DEM・JPGEO2024で実測し、結果JSONを表示する。
 * 得たJSONは scripts/apply-landmark-height-audit.mjs でカタログへ反映する。
 * 通常利用者の画面には一切表示されない。
 */
export function LandmarkHeightAuditPanel({ getViewer }: { getViewer: () => Viewer | null }) {
  const [status, setStatus] = useState("地図の準備を待っています…");
  const [results, setResults] = useState<LandmarkHeightAuditResult[]>([]);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      const viewer = getViewer();
      if (!viewer || viewer.isDestroyed() || started.current) return;
      started.current = true;
      window.clearInterval(timer);
      void run(viewer, controller.signal);
    }, 500);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(viewer: Viewer, signal: AbortSignal) {
    const targets = JAPAN_LANDMARKS
      .filter((landmark) => landmark.heightStatus === "unverified")
      .map((landmark) => ({ name: landmark.name, latitude: landmark.latitude, longitude: landmark.longitude }));
    setStatus(`PLATEAU建物を読み込んでいます…（対象${targets.length}件）`);
    await ensureHiddenPlateauBuildingsForHeightLookup(viewer);
    const output = await auditLandmarkHeights(targets, {
      resolveGround: (target) => resolveGroundPoint(target.latitude, target.longitude, target.name),
      resolvePlateauTop: async (target) => {
        const first = await resolvePlateauRoofGroundPoint(viewer, target.latitude, target.longitude, target.name, signal);
        if (first || viewer.isDestroyed()) return first;
        // App本体と同じく、タイル読込が間に合わなかった場合に一度だけ再探索する。
        viewer.scene.requestRender();
        return resolvePlateauRoofGroundPoint(viewer, target.latitude, target.longitude, target.name, signal);
      },
      sampleRing: async (points) => {
        const samples = await sampleWorldTerrainNeutral(
          points.map((point) => Cartographic.fromDegrees(point.longitude, point.latitude, 0)), signal, "1m",
          { allowWorldTerrainFallback: false }
        );
        return samples.map((sample) => Number.isFinite(sample.height) ? sample.height : null);
      },
    }, (completed, total, latest) => {
      const decision = acceptLandmarkHeightAuditResult(latest);
      setStatus(`${completed}/${total} ${latest.name}: ${decision.accepted ? `${decision.heightMeters}m` : decision.reason}`);
      setResults((current) => [...current, latest]);
    }, signal);
    setStatus(`完了（${output.length}件）。下のJSONを保存して apply スクリプトで反映してください。`);
    setDone(true);
  }

  const json = JSON.stringify({ schemaVersion: 1, measuredAtIso: new Date().toISOString(), results }, null, 2);
  return (
    <section
      role="dialog"
      aria-label="登録スポット高さ実測"
      style={{
        position: "fixed", inset: "auto 8px 8px 8px", zIndex: 10000, maxHeight: "60vh", overflow: "auto",
        background: "rgba(10,16,28,0.95)", color: "#e8eefc", padding: 12, borderRadius: 8, fontSize: 12,
      }}
    >
      <strong>登録スポット高さ実測（PLATEAU＋DEM）</strong>
      <p>{status}</p>
      <textarea readOnly value={json} style={{ width: "100%", height: 160, fontFamily: "monospace", fontSize: 11 }} />
      <button type="button" disabled={!done} onClick={() => void navigator.clipboard?.writeText(json)}>
        JSONをコピー
      </button>
    </section>
  );
}
