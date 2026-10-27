/** Times and numbers as the waterway pages write them (New York time). */
import { HOUR, type Hourly, type TideEvent } from "../series";

export const fmtUtc = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";
export const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" });

/** A short span between two times: "12m", "3h 5m", "4d". */
export function span(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.round((toMs - fromMs) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function ago(iso: string | number): string {
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m ago`;
  const days = Math.round(h / 24);
  return days < 120 ? `${days}d ago` : `since ${fmtDate.format(new Date(t))}`;
}
export const hoursOld = (iso: string) => (Date.now() - Date.parse(iso)) / 3.6e6;
export const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "--");
export const signed = (v: number, d = 1) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}` : "--");
export const cToF = (c: number) => (c * 9) / 5 + 32;

export const fmtClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
export const feet = (v: number) => (Math.abs(v) < 0.05 ? "0.0" : `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`);
export const tideText = (e: TideEvent) => `${e.type === "H" ? "high" : "low"} ${fmtClock.format(new Date(e.t)).toLowerCase()}, ${feet(e.ft)} ft`;
export const lastValue = (h: Hourly | null) => {
  const t = h ? h.lastValid() : NaN;
  return h && Number.isFinite(t) ? h.at(t) : NaN;
};
export const signedFt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
export const fmtRun = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });
export const noComma = (f: Intl.DateTimeFormat) => ({ format: (d: Date) => f.format(d).replace(",", "") });
export const fmtWhen = noComma(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" }));
export const fmtWhenMin = noComma(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }));
export const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;

export const etClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
export const etDayClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const etKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
/** New York time, short: "2:20 PM" today, "Oct 8, 3:15 AM" otherwise. */
export function fmtEt(iso: string): string {
  const d = new Date(iso);
  return etKey.format(d) === etKey.format(new Date()) ? etClock.format(d) : etDayClock.format(d);
}

/** Text for HTML: the three characters that would read as markup. */
export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const sqmi = (n: number) => `${n.toLocaleString("en-US")} square miles`;
