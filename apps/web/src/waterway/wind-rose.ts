/** Wind roses on a station's page (the weather view, under the outlook): where the wind blew from over the 3 days up
 * to the page's time, beside the 30 days up to it. With the time ahead of now, the hours past now are HRRR's forecast
 * (the newest run for each hour), as on the wind strip and the next 48 hours. Each spoke is the share of hours from one of 16 directions, banded
 * by speed on the map's wind scale; calm hours (under 3 kt) have no direction and are the share in the centre. The
 * roses share one radial scale, so their shapes compare directly; the radius goes with the square root of the share,
 * so a spoke's area follows its hours and one strong direction over a few days does not shrink the rest. */
import { DAY, HOUR } from "../series";
import { AT } from "./cursor";
import { hourOf } from "./format";
import { forecastAt } from "./forecast";
import { WIND_UNITS, windFmt, WU } from "./units";
import type { StationData } from "./station-data";
import { windColour } from "./wind-strip";

/** Hour counts: [calm, then for each direction from north clockwise its speed bands]. */
type RoseCounts = number[];

const SECTORS = 16;
const BANDS_KT = [3, 10, 15, 20]; // the speed bands' lower edges; under the first is calm
const WINDOWS = [3 * DAY, 30 * DAY];
const R = 44; // the rose's radius in viewBox units, centred in a 2R + 24 box
const CALM_R = 7.5;
const RINGS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1]; // the shares the scale's rings mark; the outermost is the rim
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const fmtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" });

/** The station's hours over the `span` seconds up to `end`: measured up to now, the forecast after; `ahead` is how
 * many of them are forecast. */
function counts(d: StationData, end: number, span: number): { c: RoseCounts; ahead: number } {
  const n = BANDS_KT.length;
  const out = new Array<number>(1 + SECTORS * n).fill(0);
  const wind = d.met?.wind, dir = d.met?.dir;
  let ahead = 0;
  if (!wind || !dir) return { c: out, ahead };
  const now = Date.now() / 1000;
  for (let t = end - span + HOUR; t <= end; t += HOUR) {
    const f = t > now ? forecastAt(d.meta.id, t) : null;
    if (t > now && !f) continue;
    const kt = f ? f.spd : wind.at(t);
    if (!Number.isFinite(kt)) continue;
    if (f) ahead++;
    if (kt < BANDS_KT[0]) {
      out[0]++;
      continue;
    }
    const deg = f ? f.dir : dir.at(t);
    if (!Number.isFinite(deg)) {
      if (f) ahead--;
      continue;
    }
    const s = Math.floor(((((deg % 360) + 360) % 360) + 180 / SECTORS) / (360 / SECTORS)) % SECTORS;
    let b = 0;
    while (b < n - 1 && kt >= BANDS_KT[b + 1]) b++;
    out[1 + s * n + b]++;
  }
  return { c: out, ahead };
}

const total = (c: RoseCounts) => c.reduce((a, b) => a + b, 0);
/** The largest spoke's share of the rose's hours (all its bands). */
function topShare(c: RoseCounts): number {
  const n = BANDS_KT.length, all = total(c);
  let top = 0;
  for (let s = 0; s < SECTORS; s++) {
    let v = 0;
    for (let b = 0; b < n; b++) v += c[1 + s * n + b];
    top = Math.max(top, v);
  }
  return all ? top / all : 0;
}
const bandKt = (b: number) => (b < BANDS_KT.length - 1 ? (BANDS_KT[b] + BANDS_KT[b + 1]) / 2 : BANDS_KT[b] + 7);

function wedge(r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  return `M${p(r0, a0)} L${p(r1, a0)} A${r1.toFixed(2)} ${r1.toFixed(2)} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0.toFixed(2)} ${r0.toFixed(2)} 0 0 0 ${p(r0, a0)}Z`;
}

/** One rose on a radial scale where `top` (a share of hours, one of RINGS) is the rim. */
function roseSvg(c: RoseCounts, top: number, label: string): string {
  const n = BANDS_KT.length;
  const all = total(c);
  const o = R + 12;
  const rOf = (v: number) => CALM_R + (R - CALM_R) * Math.sqrt(v / top);
  let g = "";
  // Rings at set shares, labelled along the north-east diagonal.
  for (const v of RINGS.filter((v) => v <= top + 1e-9)) {
    const r = rOf(v);
    g += `<circle r="${r.toFixed(2)}" class="wr-ring"/><text x="${(r * 0.707 + 1).toFixed(1)}" y="${(-r * 0.707 - 1).toFixed(1)}" class="wr-tick">${Math.round(v * 100)}%</text>`;
  }
  const half = Math.PI / SECTORS;
  for (let s = 0; s < SECTORS && all; s++) {
    const a = (s * 2 * Math.PI) / SECTORS;
    let r0 = CALM_R, cum = 0;
    for (let b = 0; b < n; b++) {
      const v = c[1 + s * n + b] / all;
      if (!v) continue;
      cum += v;
      const r1 = rOf(cum);
      g += `<path d="${wedge(r0, r1, a - half * 0.8, a + half * 0.8)}" fill="${windColour(bandKt(b))}" class="wr-band"/>`;
      r0 = r1;
    }
  }
  const calm = all ? c[0] / all : NaN;
  g += `<circle r="${CALM_R}" class="wr-calm"/><text y="2" text-anchor="middle" class="wr-calm-n">${Number.isFinite(calm) ? `${Math.round(calm * 100)}%` : "--"}</text>`;
  for (const [t, x, y] of [["N", 0, -R - 4], ["E", R + 6, 2], ["S", 0, R + 9], ["W", -R - 6, 2]] as const)
    g += `<text x="${x}" y="${y}" text-anchor="middle" class="wr-cmp">${t}</text>`;
  return `<svg viewBox="${-o} ${-o} ${2 * o} ${2 * o}" class="wr-svg" role="img" aria-label="${label}">${g}</svg>`;
}

/** The station's two roses at the page's time; empty off the weather view or for a station without wind direction. */
export function windRoseHtml(d: StationData | undefined, view: string): string {
  if (view !== "wind" || !d?.met?.dir || !d.met.wind) return "";
  const end = hourOf(AT ?? Date.now() / 1000);
  const counted = WINDOWS.map((span) => counts(d, end, span));
  const roses = counted.map((r) => r.c);
  // The longest spoke of either rose sets the scale, rounded up to the ring beyond it.
  const longest = Math.max(...roses.map(topShare));
  const top = RINGS.find((v) => v >= longest - 1e-9) ?? 1;
  const to = fmtDay.format(new Date(end * 1000));
  const figs = roses.map((c, i) => {
    const days = WINDOWS[i] / DAY;
    const from = fmtDay.format(new Date((end - WINDOWS[i] + HOUR) * 1000));
    const ahead = counted[i].ahead;
    const title = end * 1000 > Date.now() ? `${days} days to ${fmtWhen.format(new Date(end * 1000)).replace(",", "")}` : `Last ${days} days`;
    const hours = `${total(c).toLocaleString("en-US")} h${ahead ? `, ${ahead} forecast (HRRR)` : ""}`;
    return `<figure class="wr-fig">${roseSvg(c, top, `Wind rose at ${d.meta.name}, ${from} to ${to}${ahead ? `, ${ahead} hours of them forecast` : ""}`)}<figcaption><b>${title}</b>${from} to ${to} &middot; ${hours}</figcaption></figure>`;
  });
  const u = WIND_UNITS[WU].label;
  const sw = (b: number) => `<svg width="10" height="9" class="ws-sw" aria-hidden="true"><rect width="10" height="9" fill="${windColour(bandKt(b))}"/></svg>`;
  const bands = BANDS_KT.map((k, b) => `${sw(b)}${b < BANDS_KT.length - 1 ? `${windFmt(k)}&ndash;${windFmt(BANDS_KT[b + 1])}` : `${windFmt(k)}+`}`).join(" ");
  return `<section class="wr" aria-label="Wind roses at ${d.meta.name}">
    <p class="ol-title">Wind rose <span class="ol-src">where the wind blew from, share of hours</span></p>
    <div class="wr-pair">${figs.join("")}</div>
    <p class="status-key" title="The centre gives the share of calm hours (under ${windFmt(BANDS_KT[0])} ${u}); a spoke's area follows its share of the hours.">${bands} ${u} &middot; centre: calm hours</p>
  </section>`;
}
