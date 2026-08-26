import { useEffect, useState } from "react";
import type { PlannerProject } from "../types/project";
import { estimateProjectByteSize, formatByteSize } from "../projectStorage";
import "./ProjectScreens.css";

type Props = {
  open: boolean;
  projects: PlannerProject[];
  onBack: () => void;
  onLoad: (p: PlannerProject) => void;
  onUpdate: (p: PlannerProject) => void;
  onDelete: (id: string) => void;
  onShare: (p: PlannerProject) => void;
  onImport: (text: string) => void;
  onOpenQrScan: () => void;
};

export function ProjectsScreen({
  open,
  projects,
  onBack,
  onLoad,
  onUpdate,
  onDelete,
  onShare,
  onImport,
  onOpenQrScan,
}: Props) {
  const [editing, setEditing] = useState<PlannerProject | null>(null);
  const [importText, setImportText] = useState("");

  useEffect(() => {
    if (!open) {
      setEditing(null);
      setImportText("");
    }
  }, [open]);

  if (!open) return null;

  const commitImport = () => {
    const value = importText.trim();
    if (!value) return;
    onImport(value);
    setImportText("");
  };

  return (
    <section className="project-screen">
      <header>
        <button type="button" className="project-screen-back" onClick={onBack} aria-label="メイン画面へ戻る">
          ‹ 戻る
        </button>
        <h1>プロジェクト</h1>
        <span />
      </header>

      <div className="project-import-panel" aria-label="共有プロジェクトを取り込む">
        <textarea
          className="project-import-input"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") commitImport();
          }}
          placeholder="共有リンクまたはコードを貼り付け"
          aria-label="共有リンクまたはコード"
          rows={2}
        />
        <button
          type="button"
          className="primary project-import-button"
          onClick={commitImport}
          disabled={!importText.trim()}
        >
          取り込む
        </button>
        <button type="button" className="project-scan-button" onClick={onOpenQrScan}>
          <span className="project-scan-icon" aria-hidden="true">▦</span>
          <span>コードを読み取る</span>
        </button>
      </div>

      {editing ? (
        <div className="project-editor">
          <label>
            プロジェクト名
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          <label>
            撮影日時
            <input
              type="datetime-local"
              value={editing.shootingDateTimeLocal}
              onChange={(e) => setEditing({ ...editing, shootingDateTimeLocal: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={editing.calendarRegistered}
              onChange={(e) => setEditing({ ...editing, calendarRegistered: e.target.checked })}
            />
            カレンダーへ登録
          </label>
          <div className="project-actions">
            <button onClick={() => setEditing(null)}>キャンセル</button>
            <button
              className="primary"
              onClick={() => {
                onUpdate({ ...editing, updatedAtIso: new Date().toISOString() });
                setEditing(null);
              }}
            >
              変更を保存
            </button>
          </div>
        </div>
      ) : (
        <div className="project-list">
          {projects.length === 0 && <p>保存済みプロジェクトはありません。</p>}
          {projects.length > 0 && (
            <p className="project-list-total-size">
              全{projects.length}件・合計{formatByteSize(
                projects.reduce((sum, p) => sum + estimateProjectByteSize(p), 0)
              )}
            </p>
          )}
          {projects.map((p) => (
            <article key={p.id}>
              <button className="project-main" onClick={() => onLoad(p)}>
                <strong>{p.name}</strong>
                <span>
                  {p.shootingDateTimeLocal.replace("T", " ")}
                  {" ・ "}
                  {formatByteSize(estimateProjectByteSize(p))}
                </span>
              </button>
              <div className="project-card-actions">
                <label className="check project-calendar-check">
                  <input
                    type="checkbox"
                    checked={p.calendarRegistered}
                    onChange={(e) =>
                      onUpdate({
                        ...p,
                        calendarRegistered: e.target.checked,
                        updatedAtIso: new Date().toISOString(),
                      })
                    }
                  />
                  カレンダーへ登録
                </label>
                <button type="button" onClick={() => onShare(p)}>共有</button>
                <button type="button" onClick={() => setEditing(p)}>編集</button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (confirm("このプロジェクトを削除しますか？")) onDelete(p.id);
                  }}
                >
                  削除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
