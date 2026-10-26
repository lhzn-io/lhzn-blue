/** What makes one waterway page differ from another: its data, its map, its views and its words. A waterway page
 * (today the Piscataqua Region; the Long Island Sound to follow) reads everything particular to it from one of these
 * (apps/web/src/waterways/<id>.ts), so the page code holds no place names, station ids or prose of its own. */
import type { FieldControls, FieldKind } from "../fields";

export type Box = [[number, number], [number, number]];
export type Layer = FieldKind | "none";

export interface WaterwayConfig<Theme extends string = string> {
  id: string; // the page's path and the data prefix's last part, e.g. "piscataqua-region"
  name: string;
  data: string; // where its files are served, e.g. "/data/v1/piscataqua-region"
  map: { home: Box; near: Box; zonesUrl?: string; basinsUrl?: string };
  /** The view chips over the map, in order; each sets the map's layer with the status table and the sections. */
  themes: { key: Theme; label: string; layer: Layer }[];
  /** The map's layer menu. */
  layers: FieldControls["choices"];
  /** Browser storage keys for the remembered view (and the buoys' variable, where the page has one). */
  storage: { view: string; bview?: string };
  /** Hours since the last reading before a station counts as delayed, by kind (default for the rest). */
  staleHours: { default: number } & Partial<Record<string, number>>;
  /** The outage notice's standing line: how often each part of the page refreshes. */
  cadence: string;
  /** Station-specific words keyed by station or card id (subtitles, notes), so they stay out of the page code. */
  text: Record<string, string>;
  /** The Method list: [term, HTML]. */
  method: [string, string][];
  credits: string[];
}
