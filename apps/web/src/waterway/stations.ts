/** One model of a waterway's stations, whatever their source: a page's table, pins, notice and (later) station pages
 * read this, and an adapter per waterway fills it from that waterway's data files (adapters/<id>.ts). */
import type { Frame } from "./frames";
import { sec } from "./frames";

export type StationKind = "buoy" | "shore" | "level" | "meter" | "prediction" | "gauge" | "airport";

export interface Station {
  id: string;
  kind: StationKind;
  name: string; // as in its registry ("Great Bay buoy")
  label: string; // as in the status table, with its operator where that helps ("Great Bay buoy (UNH)")
  lat: number;
  lon: number;
  place?: string;
  operator?: string;
  frame?: Frame; // its live window
  lastObs?: Record<string, unknown> | null; // its newest reading ({time, ...})
  staleHours: number; // hours after its last reading before it counts as delayed
  meta: Record<string, unknown>; // its registry entry, for what only its kind uses
}

export type State = "live" | "delayed" | "offline";

/** Live within the station's own staleness, delayed up to two days, offline after (or never heard from). */
export function stateOf(t: string | null | undefined, staleHours: number, now = Date.now() / 1000): State {
  if (!t) return "offline";
  const age = (now - sec(t)) / 3600;
  return age <= staleHours ? "live" : age <= 48 ? "delayed" : "offline";
}

export const stationState = (s: Station, now?: number): State =>
  s.kind === "prediction" ? (s.frame ? "live" : "offline") : stateOf(s.lastObs?.time as string | undefined, s.staleHours, now);

/** A page's stations, with lookups by id and by kind (each kind in its registry order). */
export class Stations {
  constructor(readonly all: Station[]) {}
  byId(id: string): Station | undefined {
    return this.all.find((s) => s.id === id);
  }
  ofKind(kind: StationKind): Station[] {
    return this.all.filter((s) => s.kind === kind);
  }
}
