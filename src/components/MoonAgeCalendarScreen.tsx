import { useMemo, useState } from "react";
import { Body, Illumination, MoonPhase, SearchMoonPhase } from "astronomy-engine";
import { dateFromZonedDateTimeLocal } from "../time/zonedTime";
import "./ProjectScreens.css";

const DAY_MS = 86_400_000;
const SYNODIC_MONTH_DAYS = 29.530588853;

type Props = {
  open: boolean;
  timeZone: string;
  initialDate: Date;
  onBack: () => void;
};

type MoonDay = {
  key: string;
  day: number;
  phaseDegrees: number;
  ageDays: number;
  illumination: number;
  phaseName: string;
};

function dateKey(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function moonAgeDays(date: Date): number {
  const start = new Date(date.getTime() - 35 * DAY_MS);
  let newMoon = SearchMoonPhase(0, start, 40);
  if (!newMoon) return (MoonPhase(date) / 360) * SYNODIC_MONTH_DAYS;
  while (true) {
    const next = SearchMoonPhase(0, newMoon.AddDays(1), 35);
    if (!next || next.date.getTime() > date.getTime()) break;
    newMoon = next;
  }
  return Math.max(0, (date.getTime() - newMoon.date.getTime()) / DAY_MS);
}

function phaseName(phase: number): string {
  if (phase < 11.25 || phase >= 348.75) return "新月";
  if (phase < 78.75) return "満ちていく三日月";
  if (phase < 101.25) return "上弦";
  if (phase < 168.75) return "満ちていく凸月";
  if (phase < 191.25) return "満月";
  if (phase < 258.75) return "欠けていく凸月";
  if (phase < 281.25) return "下弦";
  return "欠けていく三日月";
}

function MoonIcon({ phaseDegrees, size = 42 }: { phaseDegrees: number; size?: number }) {
  const r = 46;
  const points: string[] = [];
  const waxing = phaseDegrees <= 180;
  for (let i = 0; i <= 48; i += 1) {
    const y = -r + (2 * r * i) / 48;
    const limb = Math.sqrt(Math.max(0, r * r - y * y));
    const boundary = waxing
      ? Math.cos((phaseDegrees * Math.PI) / 180) * limb
      : -Math.cos((phaseDegrees * Math.PI) / 180) * limb;
    points.push(`${boundary.toFixed(2)},${y.toFixed(2)}`);
  }
  const limbPoints: string[] = [];
  for (let i = 48; i >= 0; i -= 1) {
    const y = -r + (2 * r * i) / 48;
    const limb = Math.sqrt(Math.max(0, r * r - y * y));
    limbPoints.push(`${waxing ? limb : -limb},${y.toFixed(2)}`);
  }
  return (
    <svg className="moon-age-icon" width={size} height={size} viewBox="-50 -50 100 100" aria-hidden="true">
      <defs><radialGradient id="moonSurface"><stop offset="0" stopColor="#fffef1"/><stop offset="1" stopColor="#b9bcc1"/></radialGradient></defs>
      <circle r={r} fill="#07090c" stroke="#69717b" strokeWidth="2" />
      <polygon points={[...points, ...limbPoints].join(" ")} fill="url(#moonSurface)" />
      <circle r={r} fill="none" stroke="#d9dde2" strokeWidth="1.4" />
    </svg>
  );
}

export function MoonAgeCalendarScreen({ open, timeZone, initialDate, onBack }: Props) {
  const [month, setMonth] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1));
  const [selectedKey, setSelectedKey] = useState(() => dateKey(initialDate.getFullYear(), initialDate.getMonth(), initialDate.getDate()));

  const days = useMemo(() => {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const count = new Date(year, monthIndex + 1, 0).getDate();
    const result: MoonDay[] = [];
    for (let day = 1; day <= count; day += 1) {
      const key = dateKey(year, monthIndex, day);
      const date = dateFromZonedDateTimeLocal(`${key}T12:00`, timeZone);
      const phaseDegrees = ((MoonPhase(date) % 360) + 360) % 360;
      result.push({
        key,
        day,
        phaseDegrees,
        ageDays: moonAgeDays(date),
        illumination: Illumination(Body.Moon, date).phase_fraction,
        phaseName: phaseName(phaseDegrees),
      });
    }
    return result;
  }, [month, timeZone]);

  if (!open) return null;
  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const selected = days.find((day) => day.key === selectedKey) ?? days[0];
  return (
    <section className="project-screen moon-age-calendar-screen">
      <header><button type="button" onClick={onBack}>‹ 戻る</button><h1>月齢カレンダー</h1><span /></header>
      <div className="calendar-nav">
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <strong>{month.getFullYear()}年 {month.getMonth() + 1}月</strong>
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <p className="moon-calendar-offline-note">端末内の天文計算で表示・オフライン対応</p>
      <div className="calendar-week">{["日","月","火","水","木","金","土"].map((label) => <b key={label}>{label}</b>)}</div>
      <div className="moon-calendar-grid">
        {Array(firstWeekday).fill(null).map((_, index) => <span key={`empty-${index}`} />)}
        {days.map((day) => (
          <button type="button" key={day.key} className={selectedKey === day.key ? "selected" : ""} onClick={() => setSelectedKey(day.key)}>
            <span>{day.day}</span>
            <MoonIcon phaseDegrees={day.phaseDegrees} size={34} />
            <small>月齢 {day.ageDays.toFixed(1)}</small>
          </button>
        ))}
      </div>
      {selected && (
        <div className="moon-day-detail">
          <MoonIcon phaseDegrees={selected.phaseDegrees} size={82} />
          <div><h2>{selected.key.replaceAll("-", "/")}</h2><strong>{selected.phaseName}</strong><p>月齢 {selected.ageDays.toFixed(2)}日</p><p>照明率 {(selected.illumination * 100).toFixed(1)}%</p></div>
        </div>
      )}
    </section>
  );
}
