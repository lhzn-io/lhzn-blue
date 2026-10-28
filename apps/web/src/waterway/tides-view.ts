/** The tides view: the departure from the prediction and the highs and lows at a shore station (the ladder), the
 * departure at every shore station on one axis, the highest tide each day ahead, and the view's table. */
import type { Line } from "../chart";
import { DAY, grid, HOUR, type Hourly, type TideEvent } from "../series";
import { fmtDate, fmtWhen, fmtWhenMin, lastValue, signedFt } from "./format";
import { AT, atLabel } from "./cursor";
import { overallState, type StationData } from "./station-data";
import type { Built } from "./figures";
import { levelCell } from "./cells";
import { OUTLOOK } from "./outlook";
import { departure, loadTides, MOON, TIDES } from "./tides";
import { M } from "./models";

/** The departure plot: observed minus predicted, above the prediction in amber, below in willow. */
export function departureBuilt(d: StationData, x0: number, x1: number): Built {
  if (!TIDES) void loadTides();
  const xs = grid(x0, x1);
  const dep = departure(d);
  const ys = xs.map((t) => dep?.at(Math.floor(t / HOUR) * HOUR) ?? NaN);
  const ft = (v: number) => `${signedFt(v)} ft`;
  const lines: Line[] = [{ ys, color: M.palette().line, width: 1.5, label: "Observed minus predicted", fmt: ft }];
  return {
    opts: { xs, lines, unit: " ft", zero: true, marker: { x: Date.now() / 1000, label: "now" }, empty: TIDES ? "No water level in this window." : "Loading the predictions." },
    legend: [["Observed minus predicted", M.palette().line, 1]],
  };
}

/** Highs and lows: NOAA's predicted (faint) and the water's (bold) at each tide, with mean higher high water and
 * the NWS minor flood level. The observed extreme is the highest or lowest hourly mean within 2 h of the prediction. */
export function hiloBuilt(d: StationData, x0: number, x1: number): Built {
  if (!TIDES) void loadTides();
  const xs = grid(x0, x1);
  const step = xs.length > 1 ? xs[1] - xs[0] : HOUR;
  const tide = TIDES?.[d.meta.id];
  const pred = xs.map(() => NaN);
  const obs = xs.map(() => NaN);
  for (const e of tide?.hilo ?? d.tides) {
    const t = Date.parse(e.t) / 1000;
    const i = Math.round((t - xs[0]) / step);
    if (i < 0 || i >= xs.length) continue;
    pred[i] = e.ft;
    if (d.level) {
      const near = [-2, -1, 0, 1, 2].map((k) => d.level!.at(Math.round(t / HOUR) * HOUR + k * HOUR)).filter(Number.isFinite);
      if (near.length >= 3) obs[i] = e.type === "H" ? Math.max(...near) : Math.min(...near);
    }
  }
  const ft = (v: number) => `${v.toFixed(1)} ft`;
  const minor = tide?.flood_ft?.nws_minor ?? null;
  const mhhw = tide?.datums_ft?.MHHW ?? null;
  const flat = (v: number | null) => xs.map(() => (v == null ? NaN : v));
  const lines: Line[] = [
    { ys: flat(minor), color: M.palette().delayed, width: 1, opacity: 0.7, label: "NWS minor flood", tip: false },
    { ys: flat(mhhw), color: M.palette().contrast, width: 0.8, opacity: 0.35, dash: "4 3", label: "Mean higher high water", tip: false },
    { ys: pred, color: M.palette().contrast, opacity: 0.45, label: "Predicted", dots: true, fmt: ft },
    { ys: obs, color: M.palette().now, label: "Observed", dots: true, fmt: ft },
  ];
  return {
    opts: { xs, lines, unit: " ft", marker: { x: Date.now() / 1000, label: "now" }, empty: "No tides in this window." },
    legend: [["Observed", M.palette().now, 1], ["Predicted", M.palette().contrast, 0.45], ["NWS minor flood", M.palette().delayed, 0.7, "Minor flood"], ["Mean higher high water", M.palette().contrast, 0.35, "MHHW"]],
  };
}

/** The waterway, station by station: the departure from the prediction at each shore station, west to east, the
 * last 30 days on one time axis and one vertical scale; amber above the prediction, willow below. The timeline's
 * cursor is drawn across all rows. */
export function departureRowsSvg(stations: StationData[]): string {
  const shore = stations.filter((d) => d.kind === "shore");
  const deps = shore.map((d) => [d, departure(d)] as const).filter((p): p is readonly [StationData, Hourly] => !!p[1]);
  if (!deps.length) return `<p class="note">Loading the predictions.</p>`;
  const t1 = Math.floor(Date.now() / 1000 / HOUR) * HOUR, t0 = t1 - 30 * DAY;
  const W = 900, rowH = 46, left = 96, top = 6, H = top + deps.length * rowH + 22;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - 8);
  let lim = 0.5;
  for (const [, h] of deps) for (let t = t0; t <= t1; t += HOUR) { const v = h.at(t); if (Number.isFinite(v)) lim = Math.max(lim, Math.abs(v)); }
  lim = Math.ceil(lim * 2) / 2;
  const rows = deps.map(([d, h], i) => {
    const y0 = top + i * rowH + rowH / 2;
    const y = (v: number) => y0 - (v / lim) * (rowH / 2 - 3);
    const area = (sign: 1 | -1) => {
      let p = "", open = false;
      for (let t = t0; t <= t1; t += HOUR) {
        const v = h.at(t);
        if (!Number.isFinite(v)) { if (open) { p += `L${x(t - HOUR).toFixed(1)},${y0}Z`; open = false; } continue; }
        const c = sign > 0 ? Math.max(0, v) : Math.min(0, v);
        if (!open) { p += `M${x(t).toFixed(1)},${y0}`; open = true; }
        p += `L${x(t).toFixed(1)},${y(c).toFixed(1)}`;
      }
      if (open) p += `L${x(t1).toFixed(1)},${y0}Z`;
      return p;
    };
    return `<text x="${left - 10}" y="${y0 + 3}" text-anchor="end" class="sr-name">${d.meta.name}</text>` +
      `<line x1="${left}" x2="${W - 8}" y1="${y0}" y2="${y0}" stroke="currentColor" opacity="0.18"/>` +
      `<path d="${area(1)}" fill="${M.palette().delayed}" opacity="0.55"/><path d="${area(-1)}" fill="${M.palette().line}" opacity="0.5"/>`;
  }).join("");
  let ticks = "";
  for (let k = 0; k <= 30; k += 7) {
    const t = t1 - k * DAY;
    ticks += `<text x="${x(t).toFixed(1)}" y="${H - 4}" text-anchor="${k === 0 ? "end" : "middle"}" class="sr-tick">${fmtDate.format(new Date(t * 1000)).replace(/, \d{4}$/, "")}</text>`;
  }
  const cur = AT != null && AT >= t0 && AT <= t1 ? `<line x1="${x(AT).toFixed(1)}" x2="${x(AT).toFixed(1)}" y1="${top}" y2="${H - 18}" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>` : "";
  return `<svg class="sound-rows" viewBox="0 0 ${W} ${H}" role="img" aria-label="Departure from the predicted tide at each shore station, the last 30 days">${rows}${ticks}${cur}<text x="${W - 8}" y="${top + 2}" text-anchor="end" class="sr-tick">each row &plusmn;${lim.toFixed(1)} ft</text></svg>`;
}

/** A moon phase glyph, as on the tides page: a thin circle with the dark part filled in the muted ink. */
function moonGlyph(phase: string, r = 4): string {
  const ink = "var(--ink-mute)";
  const half = phase === "first_quarter" || phase === "last_quarter" ? `<path d="M0,${-r} A${r},${r} 0 0 ${phase === "first_quarter" ? 0 : 1} 0,${r} Z" fill="${ink}"/>` : "";
  return `<circle r="${r}" fill="${phase === "new" ? ink : "var(--bg)"}" stroke="${ink}" stroke-width="1"/>${half}`;
}
const phaseName = (p: string) => ({ new: "new moon", first_quarter: "first quarter", full: "full moon", last_quarter: "last quarter" })[p] ?? p;

/** The tide ladder for one station, as on the tides page: each high and low as NOAA's prediction (open circle) and
 * what the water did (gold dot), joined by a stem; amber where the water ran more than 0.5 ft beyond the prediction in
 * the direction that matters (higher at a high, lower at a low). Flood levels in muted red, mean higher high water
 * dashed, the moon's phases along the top, the hours ahead shaded. Drawn on the same time axis as the departure. */
export function drawLadder(d: StationData, x0: number, x1: number): void {
  const plot = document.getElementById(`${d.meta.id}-hilo`);
  const svg = plot?.querySelector("svg");
  if (!plot || !svg) return;
  if (!TIDES) void loadTides();
  const W = Math.max(200, svg.clientWidth || plot.clientWidth - 44), H = Math.max(120, svg.clientHeight || 200);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const tide = TIDES?.[d.meta.id];
  const events = (tide?.hilo ?? d.tides).map((e) => ({ t: Date.parse(e.t) / 1000, ft: e.ft, type: e.type })).filter((e) => e.t >= x0 && e.t <= x1);
  if (!events.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="ld-note">${TIDES ? "No tides in this window." : "Loading the predictions."}</text>`;
    return;
  }
  const obsAt = (e: { t: number; type: string }) => {
    if (!d.level || e.t > Date.now() / 1000) return NaN;
    const near = [-2, -1, 0, 1, 2].map((k) => d.level!.at(Math.round(e.t / HOUR) * HOUR + k * HOUR)).filter(Number.isFinite);
    return near.length >= 3 ? (e.type === "H" ? Math.max(...near) : Math.min(...near)) : NaN;
  };
  const rows = events.map((e) => ({ ...e, o: obsAt(e) }));
  const fl = (tide?.flood_ft ?? {}) as Record<string, number | null | undefined>;
  const minor = fl.nws_minor ?? NaN, moderate = fl.nws_moderate ?? NaN, mhhw = tide?.datums_ft?.MHHW ?? NaN;
  const vals = rows.flatMap((r) => [r.ft, r.o]).filter(Number.isFinite);
  const hi = Math.max(...vals, [moderate, minor, mhhw, 0].find(Number.isFinite) ?? 0) + 0.3;
  const lo = Math.min(-1, Math.min(...vals) - 0.3);
  const top = 18, bot = 18;
  const x = (t: number) => ((t - x0) / (x1 - x0)) * W;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
  const now = Date.now() / 1000;
  const xn = Math.min(W, Math.max(0, x(now)));
  let g = `<rect x="${xn.toFixed(1)}" y="${top}" width="${(W - xn).toFixed(1)}" height="${H - top - bot}" fill="var(--panel)" opacity="0.75"/>`;
  const step = hi - lo > 8 ? 2.5 : hi - lo > 4 ? 1 : 0.5;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    g += `<line x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--chart-grid)"/><text x="${W + 6}" y="${(y(v) + 3).toFixed(1)}" class="ld-tick">${+v.toFixed(1)} ft</text>`;
  }
  // A label each Monday, at the same place and in the same words as the departure plot's (UTC dates at midnight).
  const fmtTick = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  for (let t = Math.ceil(x0 / DAY) * DAY; t <= x1; t += DAY) {
    const day = new Date(t * 1000);
    if (day.getUTCDay() !== 1) continue;
    g += `<text x="${x(t).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="ld-tick">${fmtTick.format(day)}</text>`;
  }
  const ref = (v: number, color: string, dash: string, label: string, above: boolean, left = false) => {
    if (!Number.isFinite(v)) return "";
    const yy = y(v).toFixed(1);
    return `<line x1="0" x2="${W}" y1="${yy}" y2="${yy}" stroke="${color}" stroke-width="1"${dash ? ` stroke-dasharray="${dash}"` : ""}/>` +
      `<text x="${left ? 2 : W - 2}" y="${(y(v) + (above ? -4 : 11)).toFixed(1)}" text-anchor="${left ? "start" : "end"}" class="ld-ref">${label}</text>`;
  };
  g += ref(moderate, "var(--wp-flood)", "6 3", "moderate flood", true);
  g += ref(minor, "var(--wp-flood)", "", "minor flood", false);
  g += ref(mhhw, "var(--faint)", "5 4", "MHHW", false, true);
  g += ref(0, "var(--faint)", "2 3", "MLLW", false, true);
  if (now >= x0 && now <= x1) g += `<line x1="${xn.toFixed(1)}" x2="${xn.toFixed(1)}" y1="${top - 4}" y2="${H - bot}" stroke="var(--wp-gold)" stroke-width="1.2"/><text x="${(xn + 5).toFixed(1)}" y="${H - bot - 6}" class="ld-ref">ahead: predicted</text>`;
  const beyond = (r: (typeof rows)[number]) => Number.isFinite(r.o) && (r.type === "H" ? r.o - r.ft : r.ft - r.o) > 0.5;
  for (const r of rows) if (Number.isFinite(r.o)) g += `<line x1="${x(r.t).toFixed(1)}" x2="${x(r.t).toFixed(1)}" y1="${y(r.ft).toFixed(1)}" y2="${y(r.o).toFixed(1)}" stroke="${beyond(r) ? "var(--wp-amber)" : "var(--wp-willow)"}" stroke-width="${beyond(r) ? 2 : 1.4}"/>`;
  for (const r of rows) {
    const when = fmtWhenMin.format(new Date(r.t * 1000));
    const kind = r.type === "H" ? "High" : "Low";
    g += `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.ft).toFixed(1)}" r="2.8" fill="var(--bg)" stroke="var(--ink-mute)" stroke-width="1"><title>${kind} ${when}: predicted ${r.ft.toFixed(1)} ft</title></circle>`;
    if (Number.isFinite(r.o)) g += `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.o).toFixed(1)}" r="3.1" fill="${beyond(r) ? "var(--wp-amber)" : "var(--wp-gold)"}"><title>${kind} ${when}: observed ${r.o.toFixed(1)} ft, predicted ${r.ft.toFixed(1)} ft (${r.o >= r.ft ? "+" : "-"}${Math.abs(r.o - r.ft).toFixed(1)} ft)</title></circle>`;
  }
  for (const m of MOON) {
    const t = Date.parse(m.t) / 1000;
    if (t >= x0 && t <= x1) g += `<g transform="translate(${x(t).toFixed(1)},7)"><title>${phaseName(m.phase)}, ${fmtWhen.format(new Date(t * 1000))}</title>${moonGlyph(m.phase)}</g>`;
  }
  if (AT != null && AT >= x0 && AT <= x1) g += `<line x1="${x(AT).toFixed(1)}" x2="${x(AT).toFixed(1)}" y1="${top}" y2="${H - bot}" stroke="var(--ink)" opacity="0.6"/>`;
  svg.innerHTML = g;
}

/** The highest predicted tide each day for the next five weeks at one station, as on the tides page: a bar per day
 * (amber 0.8 ft or more above mean higher high water, willow above it, pale below), the NWS minor flood level and
 * MHHW as labelled lines, the moon's phases above. */
export function highestAheadHtml(stations: StationData[], fallback: string): string {
  const pick = OUTLOOK.peek ?? OUTLOOK.pin;
  const d = stations.find((s) => s.meta.id === pick && s.kind === "shore") ?? stations.find((s) => s.meta.id === fallback);
  const tide = d ? TIDES?.[d.meta.id] : undefined;
  if (!d || !tide?.hilo) return "";
  const now = Date.now() / 1000;
  const t0 = now - 14 * DAY, t1 = now + 35 * DAY;
  // The highest predicted tide each day, two weeks back to five weeks ahead; and the water's own highest in the past.
  const byDay = new Map<string, { t: number; ft: number; obs: number }>();
  for (const e of tide.hilo) {
    const t = Date.parse(e.t) / 1000;
    if (e.type !== "H" || t < t0 || t > t1) continue;
    const k = fmtDate.format(new Date(t * 1000));
    if (!byDay.has(k) || byDay.get(k)!.ft < e.ft) byDay.set(k, { t, ft: e.ft, obs: NaN });
  }
  if (d.level) for (const day of byDay.values()) {
    if (day.t > now) continue;
    let m = -Infinity;
    for (let h = Math.floor(day.t / HOUR) * HOUR - 2 * HOUR; h <= day.t + 2 * HOUR; h += HOUR) m = Math.max(m, d.level.at(h));
    day.obs = Number.isFinite(m) ? m : NaN;
  }
  const days = [...byDay.values()].sort((a, b) => a.t - b.t);
  const mhhw = tide.datums_ft?.MHHW ?? NaN, minor = tide.flood_ft?.nws_minor ?? NaN;
  if (days.length < 5 || !Number.isFinite(mhhw)) return "";
  const W = 480, H = 124, L = 34, top = 16, bot = 14, pw = W - L - 4;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * pw;
  const vals = days.flatMap((e) => [e.ft, e.obs]).filter(Number.isFinite);
  const lo = mhhw - 1.5, hi = Math.max(Number.isFinite(minor) ? minor : mhhw, ...vals) + 0.3;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
  const bw = Math.max(1.2, (pw / ((t1 - t0) / DAY)) * 0.55);
  let g = `<rect x="${x(now).toFixed(1)}" y="${top}" width="${(W - 4 - x(now)).toFixed(1)}" height="${H - top - bot}" class="hi-ahead-band"/>`;
  for (let v = Math.ceil(lo); v <= hi; v += 1) g += `<text x="${L - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v} ft</text>`;
  for (const e of days) {
    const c = e.ft >= mhhw + 0.8 ? "var(--wp-bar-high)" : e.ft >= mhhw ? "var(--wp-bar-mid)" : "var(--wp-bar-low)";
    const yt = y(Math.max(lo, e.ft));
    g += `<rect x="${(x(e.t) - bw / 2).toFixed(1)}" y="${yt.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - bot - yt).toFixed(1)}" fill="${c}"${e.t < now ? ' opacity="0.55"' : ""}><title>${fmtWhenMin.format(new Date(e.t * 1000))}: ${e.ft.toFixed(1)} ft predicted${Number.isFinite(e.obs) ? `, ${e.obs.toFixed(1)} ft observed` : ""}</title></rect>`;
    if (Number.isFinite(e.obs)) g += `<line x1="${(x(e.t) - bw / 2).toFixed(1)}" x2="${(x(e.t) + bw / 2).toFixed(1)}" y1="${y(e.obs).toFixed(1)}" y2="${y(e.obs).toFixed(1)}" class="hi-obs"/>`;
  }
  const ref = (v: number, color: string, dash: string, label: string) => (Number.isFinite(v)
    ? `<line x1="${L}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${color}"${dash ? ` stroke-dasharray="${dash}"` : ""}/><text x="${W - 2}" y="${(y(v) - 4).toFixed(1)}" text-anchor="end" class="ld-ref">${label}</text>`
    : "");
  g += ref(minor, "var(--wp-flood)", "", "NWS minor flood") + ref(mhhw, "var(--faint)", "5 4", "MHHW");
  const fmtTick = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", weekday: "short" });
  for (const e of days) {
    const parts = fmtTick.format(new Date(e.t * 1000));
    if (parts.startsWith("Mon")) g += `<text x="${x(e.t).toFixed(1)}" y="${H - 3}" text-anchor="middle">${parts.replace(/^Mon, /, "")}</text>`;
  }
  for (const m of MOON) {
    const t = Date.parse(m.t) / 1000;
    if (t >= t0 && t <= t1) g += `<g transform="translate(${x(t).toFixed(1)},6)"><title>${phaseName(m.phase)}, ${fmtWhen.format(new Date(t * 1000))}</title>${moonGlyph(m.phase, 3.5)}</g>`;
  }
  const cur = AT ?? now;
  if (cur >= t0 && cur <= t1) g += `<line x1="${x(cur).toFixed(1)}" x2="${x(cur).toFixed(1)}" y1="${top - 2}" y2="${H - bot}" class="hi-cursor"/>`;
  const ahead = days.filter((e) => e.t >= now);
  const peak = (ahead.length ? ahead : days).reduce((a, b) => (b.ft > a.ft ? b : a));
  const sw = (c: string) => `<i style="display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px;background:${c}"></i>`;
  return `<section class="hi-ahead" aria-label="Highest tides at ${d.meta.name}">
    <p class="ol-title">Highest tide each day &middot; ${d.meta.name} <span class="ol-hint">pick a row above</span></p>
    <svg viewBox="0 0 ${W} ${H}" class="hi-svg" role="img" aria-label="Highest tide each day, two weeks back to five weeks ahead">${g}</svg>
    <p class="status-key">highest ahead ${peak.ft.toFixed(1)} ft, ${fmtWhenMin.format(new Date(peak.t * 1000))}${Number.isFinite(minor) ? `; ${(minor - peak.ft).toFixed(1)} ft below minor flood` : ""}</p>
    <p class="status-key">${sw("var(--wp-bar-high)")}0.8 ft or more above MHHW ${sw("var(--wp-bar-mid)")}above ${sw("var(--wp-bar-low)")}below; <i style="display:inline-block;width:10px;height:0;border-top:1.6px solid var(--wp-gold);vertical-align:3px;margin-right:4px"></i>observed</p>
  </section>`;
}

/** The table's caption in the Tides view: the moon at the cursor's time (or now), then the time. */
function moonCaption(t: number): string {
  const ev = MOON.map((m) => ({ ...m, t: Date.parse(m.t) / 1000 }));
  const when = AT != null ? atLabel(AT) : "Now";
  if (!ev.length) return when;
  const near = ev.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const days = Math.round((t - near.t) / DAY);
  const name = phaseName(near.phase).replace(/^(first|last) quarter$/, "$1 quarter moon");
  const phrase = days === 0 ? `${name[0].toUpperCase()}${name.slice(1)}` : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "after" : "before"} the ${name}`;
  return `<svg class="cap-moon" width="11" height="11" viewBox="-5.5 -5.5 11 11" aria-hidden="true">${moonGlyph(near.phase, 4.2)}</svg>${phrase} &middot; ${when}`;
}

/** The Tides view's table: per shore station, the water against the prediction, the next high and low, and how far
 * the next high would stay below minor flooding if the current departure held. */
export function tidesTable(stations: StationData[]): string {
  const shore = stations.filter((d) => d.kind === "shore");
  const at = AT ?? Date.now() / 1000;
  const rows = shore.map((d) => {
    const dep = departure(d);
    const depNow = AT != null ? (dep?.at(Math.floor(AT / HOUR) * HOUR) ?? NaN) : lastValue(dep);
    const next = (type: "H" | "L") => d.tides.find((e) => e.type === type && Date.parse(e.t) / 1000 > at);
    const hi = next("H"), lo = next("L");
    const minor = TIDES?.[d.meta.id]?.flood_ft?.nws_minor ?? null;
    const reach = hi && Number.isFinite(depNow) ? hi.ft + depNow : NaN;
    const ev = (e?: TideEvent) => (e ? `<td><b>${e.ft.toFixed(1)}<small class="g"> ft</small></b><small>${fmtWhenMin.format(new Date(e.t))}</small></td>` : `<td class="na">&middot;</td>`);
    const depCell = Number.isFinite(depNow) ? `<td title="Observed minus NOAA's prediction"><b>${signedFt(depNow)}<small class="g"> ft</small></b><small>vs prediction</small></td>` : `<td class="na">&middot;</td>`;
    const margin = minor != null && Number.isFinite(reach)
      ? `<td title="NWS minor flood ${minor.toFixed(1)} ft; next high ${hi!.ft.toFixed(1)} ft predicted, ${reach.toFixed(1)} ft with the current departure"><b>${(minor - reach).toFixed(1)}<small class="g"> ft</small></b><small>below</small></td>`
      : `<td class="na">&middot;</td>`;
    return `<tr><th scope="row"><a href="#${d.meta.id}"><i class="dot shore ${overallState(d)}"></i>${d.meta.name}</a></th>${levelCell(d)}${depCell}${ev(hi)}${ev(lo)}${margin}</tr>`;
  });
  return `<table class="status-grid" id="status-panel"><caption>${moonCaption(AT ?? Date.now() / 1000)}</caption>
    <thead><tr><th></th><th scope="col">Level</th><th scope="col">Departure</th><th scope="col">Next high</th><th scope="col">Next low</th><th scope="col">Below flood</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>
    <p class="status-key">feet above MLLW, preliminary; highs and lows predicted; below flood: the next high plus the current departure, against NWS minor flood</p>`;
}

