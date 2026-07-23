import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onCancel: () => void;
  onSave: (name: string, calendarRegistered: boolean) => void;
};

export function ProjectSaveDialog({ open, onCancel, onSave }: Props) {
  const [name, setName] = useState("");
  const [calendarRegistered, setCalendarRegistered] = useState(false);
  useEffect(() => { if (open) { setName(""); setCalendarRegistered(false); } }, [open]);
  if (!open) return null;
  return <div className="project-dialog-backdrop" role="presentation">
    <section className="project-dialog" role="dialog" aria-modal="true" aria-label="プロジェクト保存">
      <h2>プロジェクトを保存</h2>
      <label>プロジェクト名<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="未入力時は保存日時" /></label>
      <label className="project-dialog-check"><input type="checkbox" checked={calendarRegistered} onChange={(e) => setCalendarRegistered(e.target.checked)} />撮影日をカレンダーへ登録する</label>
      <div><button type="button" onClick={onCancel}>キャンセル</button><button type="button" className="primary" onClick={() => onSave(name.trim(), calendarRegistered)}>保存</button></div>
    </section>
  </div>;
}
