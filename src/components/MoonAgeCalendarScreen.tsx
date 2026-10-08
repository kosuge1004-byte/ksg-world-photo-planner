import { useMemo, useState } from "react";
import { Body, Illumination, MoonPhase, SearchMoonPhase } from "astronomy-engine";
import { dateFromZonedDateTimeLocal, zonedDateTimeLocalFromDate } from "../time/zonedTime";
import { findMoonriseOnDate, type MoonriseInput } from "../time/moonrise";
import "./ProjectScreens.css";

const DAY_MS = 86_400_000;
const SYNODIC_MONTH_DAYS = 29.530588853;

type Props = {
  open: boolean;
  timeZone: string;
  initialDate: Date;
  /**
   * 各日の月の出を求めるための入力。地点は「カレンダーを開いた時に地図で表示していた
   * 場所」。移動ボタンの移動先（呼び出し側）も同じ入力で求めるので、表示と一致する。
   */
  moonriseInput?: MoonriseInput;
  onBack: () => void;
  /**
   * 「この日の月の出へ移動」を押したときに呼ばれる（"YYYY-MM-DD"）。
   * 日付を押しただけでは呼ばれない（2026-10-09: 押すと即移動する動作を廃止）。
   * 移動と画面を閉じる処理は呼び出し側。
   */
  onJumpToDate?: (dateKey: string) => void;
};

type MoonDay = {
  key: string;
  day: number;
  phaseDegrees: number;
  ageDays: number;
  illumination: number;
  phaseName: string;
  /** その日の月の出（"HH:MM"）。月の出が無い日・地点不明はnull。 */
  moonriseTime: string | null;
};

/** アプリのタイムゾーンでの日付（"YYYY-MM-DD"）。 */
function zonedDateKey(date: Date, timeZone: string): string {
  return zonedDateTimeLocalFromDate(date, timeZone).slice(0, 10);
}

function monthStartOf(key: string): Date {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

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

export function MoonAgeCalendarScreen({ open, timeZone, initialDate, moonriseInput, onBack, onJumpToDate }: Props) {
  // 開いた時は、メイン画面で表示中の日付を選んだ状態にする。
  const [selectedKey, setSelectedKey] = useState(() => zonedDateKey(initialDate, timeZone));
  const [month, setMonth] = useState(() => monthStartOf(zonedDateKey(initialDate, timeZone)));

  function showToday(): void {
    const todayKey = zonedDateKey(new Date(), timeZone);
    setMonth(monthStartOf(todayKey));
    setSelectedKey(todayKey);
  }

  const days = useMemo(() => {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const count = new Date(year, monthIndex + 1, 0).getDate();
    const result: MoonDay[] = [];
    for (let day = 1; day <= count; day += 1) {
      const key = dateKey(year, monthIndex, day);
      const date = dateFromZonedDateTimeLocal(`${key}T12:00`, timeZone);
      const phaseDegrees = ((MoonPhase(date) % 360) + 360) % 360;
      const moonrise = moonriseInput ? findMoonriseOnDate(moonriseInput, key) : null;
      result.push({
        key,
        day,
        phaseDegrees,
        ageDays: moonAgeDays(date),
        illumination: Illumination(Body.Moon, date).phase_fraction,
        phaseName: phaseName(phaseDegrees),
        moonriseTime: moonrise
          ? zonedDateTimeLocalFromDate(moonrise, moonriseInput?.timeZone ?? timeZone).slice(11, 16)
          : null,
      });
    }
    return result;
  }, [month, timeZone, moonriseInput]);

  if (!open) return null;
  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  // 選んだ日が表示中の月に無い場合（月を送った後など）は、下の詳細と移動ボタンを出さない。
  const selected = days.find((day) => day.key === selectedKey) ?? null;
  const location = moonriseInput?.location ?? null;
  return (
    <section className="project-screen moon-age-calendar-screen">
      <header><button type="button" className="project-screen-back" onClick={onBack} aria-label="メイン画面へ戻る">‹ 戻る</button><h1>月齢カレンダー</h1><span /></header>
      <div className="calendar-nav moon-calendar-nav">
        <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="前の月">‹</button>
        <strong>{month.getFullYear()}年 {month.getMonth() + 1}月</strong>
        <span className="moon-calendar-nav-actions">
          <button type="button" className="moon-calendar-today" onClick={showToday}>今日</button>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="次の月">›</button>
        </span>
      </div>
      <p className="moon-calendar-offline-note">
        {location
          ? `月の出は地図の表示位置（北緯${location.latitude.toFixed(2)}° 東経${location.longitude.toFixed(2)}°）の時刻`
          : "端末内の天文計算で表示・オフライン対応"}
      </p>
      <div className="calendar-week">{["日","月","火","水","木","金","土"].map((label) => <b key={label}>{label}</b>)}</div>
      <div className="moon-calendar-grid">
        {Array(firstWeekday).fill(null).map((_, index) => <span key={`empty-${index}`} />)}
        {days.map((day) => (
          <button
            type="button"
            key={day.key}
            className={selectedKey === day.key ? "selected" : ""}
            aria-pressed={selectedKey === day.key}
            onClick={() => setSelectedKey(day.key)}
            aria-label={`${day.key.replaceAll("-", "/")} 月齢${day.ageDays.toFixed(1)} ${day.moonriseTime ? `月の出${day.moonriseTime}` : "月の出なし"}`}
          >
            <span>{day.day}</span>
            <MoonIcon phaseDegrees={day.phaseDegrees} size={30} />
            <small>月齢 {day.ageDays.toFixed(1)}</small>
            {moonriseInput && <small className="moon-rise-time">{day.moonriseTime ? `出 ${day.moonriseTime}` : "出 —"}</small>}
          </button>
        ))}
      </div>
      {selected && (
        <div className="moon-day-detail">
          <MoonIcon phaseDegrees={selected.phaseDegrees} size={38} />
          <div className="moon-day-detail-text">
            <strong>{selected.key.replaceAll("-", "/")}</strong>
            <p>{selected.phaseName}・月齢 {selected.ageDays.toFixed(1)}</p>
            <p>
              照明率 {(selected.illumination * 100).toFixed(0)}%
              {moonriseInput ? `・月の出 ${selected.moonriseTime ?? "なし"}` : ""}
            </p>
          </div>
          {onJumpToDate && (
            <button type="button" className="moon-day-jump" onClick={() => onJumpToDate(selected.key)}>
              {selected.moonriseTime ? <>この日の<br />月の出へ移動</> : "この日へ移動"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
