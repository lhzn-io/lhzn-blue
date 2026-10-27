/** What makes one waterway page differ from another: its data, its map, its views and its words. A waterway page
 * (today the Piscataqua Region; the Long Island Sound to follow) reads everything particular to it from one of these
 * (apps/web/src/waterways/<id>.ts), so the page code holds no place names, station ids or prose of its own. */
import type { FieldControls, FieldKind } from "../fields";
import type { StationKind } from "./stations";
import type { VarKey } from "./station-data";

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
  /** Station pages (/<id>/<station>/): the views each kind of station has there (the first is its default); a kind
   * not listed has no page of its own. */
  stationThemes: Partial<Record<StationKind, Theme[]>>;
  /** The navigation row: kinds shown as their own chips after Overview, and the menu for the rest, in groups. */
  nav: { chips: StationKind[]; menu: { title: string; kinds: StationKind[] }[] };
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

/** The parts of a waterway page built on the station-data engine (waterway/station-data.ts and the modules around it)
 * that are its own: where its data is, the stations it opens on, and its words. The Long Island Sound's page reads one
 * (waterways/long-island-sound.ts); the region's will when it moves onto the same page. */
export interface StationDataWaterway {
  id: string; // the page's path, e.g. "long-island-sound"
  name: string;
  data: string; // where its files are served
  called: string; // the waterway as a sentence names it ("the Sound")
  operator: string; // who runs its buoys, as their links and notes name them ("LISICOS")
  oxygenAuthority: string; // whose hypoxia levels the oxygen shading follows
  forecastPage: string; // the forecast verification page the forecasts link to
  zones: string[]; // the NWS marine zones on its map
  /** The stations a page opens on: an embed's, the outlook's, and the tide gauge the tides view falls back to. */
  defaults: { embedStation: string; outlookStation: string; tideStation: string };
  /** The headings over each group of station sections. */
  groups: { buoy: string; shore: string; airport: string; rivers: string; turbidity: string };
  /** The all-rivers summary: where it sits on the map, and its note. */
  rivers: { at: [number, number]; note: (gauges: number, sqmi: number) => string };
  turbidityNote: string; // the buoy turbidity section's note (its sensors and their check)
  /** The outage note's words: the operator's, and what the readings since then are. */
  outage: { operator: string; transcribed: string };
  collect: { credit: string; mailTo: string };
  /** Station pages, where the page is mounted with them: the views each kind of station has there (the first is its
   * default; a kind not listed has no page), the kinds shown as their own links after Overview, and the menu for the
   * rest, in groups. */
  stationPages?: { views: Partial<Record<string, VarKey[]>>; chips: string[]; menu: { title: string; kinds: string[] }[] };
  /** Our own photos of its stations, by id: the image (under public/), what it shows, and when it was taken. */
  photos?: Record<string, { src: string; alt: string; when: string }>;
}
