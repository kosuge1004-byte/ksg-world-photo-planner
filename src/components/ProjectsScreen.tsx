import { useEffect, useState } from "react";
import type { PlannerProject } from "../types/project";
import "./ProjectScreens.css";

type Props = { open: boolean; projects: PlannerProject[]; onBack: () => void; onLoad: (p: PlannerProject) => void; onUpdate: (p: PlannerProject) => void; onDelete: (id: string) => void; };
export function ProjectsScreen({ open, projects, onBack, onLoad, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState<PlannerProject | null>(null);
  useEffect(() => { if (!open) setEditing(null); }, [open]);
  if (!open) return null;
  return <section className="project-screen"><header><button onClick={onBack}>‹ 戻る</button><h1>プロジェクト</h1><span /></header>
    {editing ? <div className="project-editor"><label>プロジェクト名<input value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><label>撮影日時<input type="datetime-local" value={editing.shootingDateTimeLocal} onChange={e=>setEditing({...editing,shootingDateTimeLocal:e.target.value})}/></label><label className="check"><input type="checkbox" checked={editing.calendarRegistered} onChange={e=>setEditing({...editing,calendarRegistered:e.target.checked})}/>カレンダーへ登録</label><div className="project-actions"><button onClick={()=>setEditing(null)}>キャンセル</button><button className="primary" onClick={()=>{onUpdate({...editing,updatedAtIso:new Date().toISOString()});setEditing(null)}}>変更を保存</button></div></div>
    : <div className="project-list">{projects.length===0&&<p>保存済みプロジェクトはありません。</p>}{projects.map(p=><article key={p.id}><button className="project-main" onClick={()=>onLoad(p)}><strong>{p.name}</strong><span>{p.shootingDateTimeLocal.replace("T"," ")}</span></button><label className="check"><input type="checkbox" checked={p.calendarRegistered} onChange={e=>onUpdate({...p,calendarRegistered:e.target.checked,updatedAtIso:new Date().toISOString()})}/>カレンダーへ登録</label><div><button onClick={()=>setEditing(p)}>編集</button><button className="danger" onClick={()=>{if(confirm("このプロジェクトを削除しますか？"))onDelete(p.id)}}>削除</button></div></article>)}</div>}
  </section>;
}
