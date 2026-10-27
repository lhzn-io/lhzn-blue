/** Times and numbers as the waterway pages write them (New York time). */

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
