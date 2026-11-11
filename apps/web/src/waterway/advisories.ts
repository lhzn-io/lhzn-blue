/** NWS marine warnings and advisories for each station's forecast zone, from the IEM VTEC archive (the record), and the
 * zones under a wind advisory at a time (NWS's active alerts for the present). A zone retired in a split (on the Sound,
 * ANZ330 before April 2021) stands for the zones it became, up to the split. */
import { alertsNow } from "../advisory";
import { getJson } from "@lhzn-io/timecharts/series";
import { fmtWhenMin } from "./format";
import { DATA, requestRedraw } from "./data";

export interface Advisories {
  kinds: Record<string, string>;
  zones: Record<string, { name: string; stations: string[] }>;
  retired: Record<string, { until: string; into: string[]; name: string }>;
  events: Record<string, [string, string, string, string][]>;
}
export interface Advisory { kind: string; t0: number; t1: number; zone: string }
export let ADV: Advisories | null = null;
let advLoading: Promise<void> | null = null;
const ADV_CACHE = new Map<string, Advisory[]>();
// Shaded behind the wind: small craft (lighter), gale and stronger (darker). Fog and the rest are not about wind.
export const ADV_WIND: Record<string, 0 | 1> = { "SC.Y": 0, "SE.W": 0, "GL.W": 1, "SR.W": 1, "HF.W": 1, "TR.W": 1, "HU.W": 1 };

export function loadAdvisories(): Promise<void> {
  advLoading ??= getJson<Advisories>(`${DATA}/advisories.json`)
    .then((a) => {
      ADV = a;
      ADV_CACHE.clear();
      requestRedraw();
    })
    .catch(() => undefined);
  return advLoading;
}

const advTime = (s: string) => Date.parse(s.replace(/Z$/, ":00Z")) / 1000;

export function zoneOf(id: string): string | null {
  for (const [z, v] of Object.entries(ADV?.zones ?? {})) if (v.stations.includes(id)) return z;
  return null;
}

/** A station's advisories, oldest first: its zone's, and the retired zone's before the split. */
export function advisoriesFor(id: string): Advisory[] {
  if (!ADV) return [];
  const hit = ADV_CACHE.get(id);
  if (hit) return hit;
  const z = zoneOf(id);
  const out: Advisory[] = [];
  if (z) {
    for (const [old, r] of Object.entries(ADV.retired ?? {})) {
      if (!r.into.includes(z)) continue;
      const until = advTime(r.until);
      for (const e of ADV.events[old] ?? []) if (advTime(e[1]) < until) out.push({ kind: e[0], t0: advTime(e[1]), t1: Math.min(advTime(e[2]), until), zone: old });
    }
    for (const e of ADV.events[z] ?? []) out.push({ kind: e[0], t0: advTime(e[1]), t1: advTime(e[2]), zone: z });
  }
  out.sort((a, b) => a.t0 - b.t0);
  ADV_CACHE.set(id, out);
  return out;
}

export interface WindSpan { x0: number; x1: number; rank: 0 | 1; title: string }

/** A station's wind advisories over a window, from the record and from NWS's alerts in force (which carry the hours
 * ahead an advisory is issued for), merged per severity; a gale's hours are not drawn again as small craft. */
export function windAdvisorySpans(id: string, x0: number, x1: number): WindSpan[] {
  const z = zoneOf(id);
  if (!z) return [];
  const raw: WindSpan[] = [];
  const add = (kind: string, name: string, t0: number, t1: number) => {
    if (!(kind in ADV_WIND) || !(t1 > x0 && t0 < x1)) return;
    raw.push({ x0: t0, x1: t1, rank: ADV_WIND[kind], title: `${name}, ${z}: ${fmtWhenMin.format(new Date(t0 * 1000))} to ${fmtWhenMin.format(new Date(t1 * 1000))}` });
  };
  for (const a of advisoriesFor(id)) add(a.kind, ADV?.kinds[a.kind] ?? a.kind, a.t0, a.t1);
  const now = alertsNow();
  for (const a of now?.alerts ?? []) {
    if (!a.zones.includes(z)) continue;
    const sp = a.by_zone?.[z];
    const t0 = Date.parse(sp?.from ?? now!.generated_at) / 1000;
    const t1 = Date.parse(sp?.until ?? a.ends ?? "") / 1000;
    if (Number.isFinite(t0) && Number.isFinite(t1)) add(a.kind, a.event, t0, t1);
  }
  const merged = (rank: 0 | 1): WindSpan[] => {
    const out: WindSpan[] = [];
    for (const s of raw.filter((r) => r.rank === rank).sort((a, b) => a.x0 - b.x0)) {
      const last = out[out.length - 1];
      if (last && s.x0 <= last.x1) {
        last.x1 = Math.max(last.x1, s.x1);
        if (!last.title.includes(s.title)) last.title += `; ${s.title}`;
      } else out.push({ ...s });
    }
    return out;
  };
  const gale = merged(1);
  const small = merged(0).flatMap((s) => {
    let parts = [s];
    for (const g of gale) {
      parts = parts.flatMap((p) => (g.x1 <= p.x0 || g.x0 >= p.x1 ? [p] : [
        ...(g.x0 > p.x0 ? [{ ...p, x1: g.x0 }] : []),
        ...(g.x1 < p.x1 ? [{ ...p, x0: g.x1 }] : []),
      ]));
    }
    return parts;
  });
  return [...small, ...gale];
}

/** A waterway's zones with a wind advisory in force at a time (epoch seconds): from NWS's active alerts for the
 * present (the hourly file), from the daily record for earlier times; the most severe per zone. */
export function zonesInForce(t: number, zones: string[]): { id: string; strong: boolean; title: string }[] {
  const out = new Map<string, { id: string; strong: boolean; title: string; rank: number }>();
  const put = (id: string, kind: string, name: string, t0: number, t1: number) => {
    if (!(kind in ADV_WIND) || t < t0 || t >= t1) return;
    const rank = ADV_WIND[kind];
    if ((out.get(id)?.rank ?? -1) >= rank) return;
    out.set(id, { id, strong: rank > 0, rank, title: `${name}, ${id}: ${fmtWhenMin.format(new Date(t0 * 1000))} to ${fmtWhenMin.format(new Date(t1 * 1000))}` });
  };
  const now = alertsNow();
  for (const a of now?.alerts ?? []) {
    for (const z of a.zones) {
      const sp = a.by_zone?.[z];
      const t0 = sp?.from ? Date.parse(sp.from) / 1000 : Date.parse(now!.generated_at) / 1000;
      const t1 = Date.parse(sp?.until ?? a.ends ?? "") / 1000;
      if (Number.isFinite(t1)) put(z, a.kind, a.event, t0, t1);
    }
  }
  if (ADV) {
    for (const z of zones) {
      const own = (ADV.events[z] ?? []).map((e) => [e[0], advTime(e[1]), advTime(e[2])] as const);
      const old = Object.entries(ADV.retired ?? {}).filter(([, r]) => r.into.includes(z))
        .flatMap(([o, r]) => (ADV!.events[o] ?? []).map((e) => [e[0], advTime(e[1]), Math.min(advTime(e[2]), advTime(r.until))] as const));
      for (const [kind, t0, t1] of [...old, ...own]) put(z, kind, ADV.kinds[kind] ?? kind, t0, t1);
    }
  }
  return [...out.values()].map(({ id, strong, title }) => ({ id, strong, title }));
}
