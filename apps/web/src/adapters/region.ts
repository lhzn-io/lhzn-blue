/** The station model from a registry-driven waterway (jobs: region.py): its registry (stations/<id>.json) and the one
 * combined live file (`<prefix>live.json`). The Sound's separate files get their own adapter (adapters/sound.ts). */
import type { WaterwayConfig } from "../waterway/config";
import type { Frame } from "../waterway/frames";
import { Stations, type Station, type StationKind } from "../waterway/stations";

type Entry = { id: string; name: string; lat: number; lon: number; place?: string; operator?: string; [k: string]: unknown };
export interface RegionRegistry {
  shore: { stations: (Entry & { products: string[] })[] };
  levels: (Entry & { datum: string })[];
  buoys: Entry[];
  currents: { meters: Entry[]; predictions: Entry[] };
  rivers: { gauges: (Entry & { river: string })[] };
  asos: { stations: Entry[] };
}
type Live = {
  shore?: { stations: Record<string, Frame & { last_obs?: Record<string, unknown> | null }> };
  levels?: Record<string, Frame & { last_obs?: Record<string, unknown> | null }>;
  buoys?: Record<string, Frame & { last_obs?: Record<string, unknown> | null }>;
  current_meters?: Record<string, Frame & { last_obs?: Record<string, unknown> | null }>;
  current_predictions?: Record<string, Frame>;
  rivers?: { gauges: Record<string, Frame & { last_obs?: Record<string, unknown> | null }> };
  asos?: { stations: Record<string, Frame & { last_obs?: Record<string, unknown> | null }> };
};

/** Every station in the registry, in its order (buoys, shore, levels, meters, predictions, gauges, airports), with
 * its live window. A shore station that only publishes predictions keeps `meta.products` to say so. */
export function regionStations(reg: RegionRegistry, file: object, cfg: WaterwayConfig): Stations {
  const live = file as Live; // the page keeps its own, richer types for the same file
  const op = (e: Entry) => (e.operator ? cfg.text[`op:${e.operator}`] : undefined);
  const stale = (kind: StationKind) => cfg.staleHours[kind] ?? cfg.staleHours.default;
  const make = (kind: StationKind, e: Entry, frame: (Frame & { last_obs?: Record<string, unknown> | null }) | undefined, name = e.name, labelled = true): Station => {
    const short = cfg.text[`short:${e.id}`] ?? name;
    const o = labelled ? op(e) : undefined;
    return {
      id: e.id, kind, name, label: o ? `${short} (${o})` : short, lat: e.lat, lon: e.lon, place: e.place, operator: e.operator,
      frame, lastObs: frame?.last_obs ?? null, staleHours: stale(kind), meta: e,
    };
  };
  return new Stations([
    ...reg.buoys.map((b) => make("buoy", b, live.buoys?.[b.id])),
    ...reg.shore.stations.map((s) => make("shore", s, live.shore?.stations[s.id])),
    ...reg.levels.map((g) => make("level", g, live.levels?.[g.id], g.name, false)),
    ...reg.currents.meters.map((m) => make("meter", m, live.current_meters?.[m.id])),
    ...reg.currents.predictions.map((p) => make("prediction", p, live.current_predictions?.[p.id], p.name, false)),
    ...reg.rivers.gauges.map((g) => make("gauge", g, live.rivers?.gauges[g.id], `${g.river} River`, false)),
    ...reg.asos.stations.map((a) => make("airport", a, live.asos?.stations[a.id])),
  ]);
}

/** The shore stations that measure (not only predict): the first is the waterway's reference gauge. */
export const measuringShore = (s: Stations) => s.ofKind("shore").filter((x) => ((x.meta.products as string[]) ?? []).length > 1);
