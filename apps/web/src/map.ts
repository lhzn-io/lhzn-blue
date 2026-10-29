/** Locator map: OpenFreeMap basemaps (OpenStreetMap data, no API key) with a bright pin per buoy (round) and
 * per shore station (square), dark or light to match the page theme. In the Rivers view it shows each river's
 * watershed down to its mouth on the Sound (faint, dashed) and, within it, the basin above the gauge (what the
 * gauge's flow measures), with a triangle at the gauge; pointing at a river highlights both and fits the map to
 * the watershed. Basins from USGS NLDI, simplified. Loaded on demand so the rest of the page does not wait for
 * MapLibre. */
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";

// partial: weather live, water sensors offline; asof: observed at the timeline cursor's time
type PinState = "live" | "delayed" | "offline" | "partial" | "asof";

export interface Pin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: PinState;
  kind?: "buoy" | "shore" | "gauge";
  label: string; // short reading for the popup, e.g. "Surface 66.3 F, 1h ago"
  bar?: number | null; // Tides view: the departure from the prediction, ft, drawn as a line up or down from the pin
}

/** A pin's departure line: up for water above the prediction, down for below, 26 px a foot (4 to 44 px). */
function setBar(el: HTMLElement, v: number | null | undefined): void {
  const bar = el.querySelector<HTMLElement>(".pin-bar");
  if (!bar) return;
  if (v == null || !Number.isFinite(v)) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.style.height = `${Math.min(44, Math.max(4, Math.abs(v) * 26)).toFixed(1)}px`;
  bar.classList.toggle("down", v < 0);
}

const STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
} as const;
type Theme = keyof typeof STYLES;

/** The Sound, the map's home view: the NWS marine zones' extent (ANZ335, ANZ331, ANZ332), to the shore. */
let HOME: maplibregl.LngLatBoundsLike = [
  [-73.83, 40.77],
  [-71.85, 41.40],
];
/** Around the Sound: a location outside this is not used to centre the map. */
let NEAR: [[number, number], [number, number]] = [[-74.4, 40.4], [-71.3, 41.8]];
let ZONES_URL = "/nws-zones-lis.json";
let BASINS_URL = "/basins.geojson";

/** Another waterway's map: its home view, the area a reader's location must fall in to centre the map, and its own
 * NWS zones and river basins files. Call before drawMap; anything left out keeps the Sound's value. */
export function configureMap(o: { home?: [[number, number], [number, number]]; near?: [[number, number], [number, number]]; zonesUrl?: string; basinsUrl?: string }): void {
  if (o.home) HOME = o.home;
  if (o.near) NEAR = o.near;
  if (o.zonesUrl) ZONES_URL = o.zonesUrl;
  if (o.basinsUrl) BASINS_URL = o.basinsUrl;
}
const BASIN_COLOR: Record<Theme, string> = { dark: "#7fb8d8", light: "#133c8b" };

let current: maplibregl.Map | null = null;
let theme: Theme = "dark";

// Other modules (the surface fields) add layers too: they register here to be called whenever a style is loaded,
// since a theme switch replaces the style and drops every custom layer, source and image.
const styleHooks: ((map: maplibregl.Map, theme: Theme) => void)[] = [];
let resolveReady: (map: maplibregl.Map) => void = () => {};
const ready = new Promise<maplibregl.Map>((r) => (resolveReady = r));

/** The map, once its first style has loaded. */
export const mapReady = (): Promise<maplibregl.Map> => ready;

/** Run `hook` on every style load (and now, if a style is already loaded). */
export function onStyle(hook: (map: maplibregl.Map, theme: Theme) => void): void {
  styleHooks.push(hook);
  if (current?.isStyleLoaded()) hook(current, theme);
}

/** The zoom the map comes in to for one place (a station, the reader's location). */
export const PLACE_ZOOM = 9.6;

/** Centre the map on a place near the Sound (the reader's own location, when they turn that on; a station's page), or
 * return to the whole Sound (null); with `jump`, at once rather than in flight. Returns false when the place is not
 * near the Sound. */
export async function focusOn(at: { lon: number; lat: number; zoom?: number } | null, jump = false): Promise<boolean> {
  // The map as soon as it exists (moving it needs no tiles); before it is drawn, wait for it.
  const map = current ?? (await mapReady());
  if (!at) {
    map.fitBounds(HOME, { padding: map.getContainer().clientWidth < 560 ? 6 : 24, duration: jump ? 0 : 600 });
    return true;
  }
  const [[x0, y0], [x1, y1]] = NEAR;
  if (at.lon < x0 || at.lon > x1 || at.lat < y0 || at.lat > y1) return false;
  const view = { center: [at.lon, at.lat] as [number, number], zoom: at.zoom ?? Math.max(map.getZoom(), PLACE_ZOOM) };
  if (jump) map.jumpTo(view);
  else map.flyTo({ ...view, duration: 900 });
  return true;
}

/** Fit the map to its box again after the page changes the box's size (a current meter's page makes it an inset):
 * the map's own watch on its size misses a change made while the page is in the background. */
export function refitMap(): void {
  current?.resize();
}

/** The page theme the map is drawn in. */
export const mapTheme = (): Theme => theme;

/* NWS marine zones: a zone's outline in brick red while a wind advisory is in force at the page's time (dashed for a
 * small craft advisory, solid and heavier for a gale or stronger warning). Outlines from NWS (scripts/fetch-zones.py),
 * loaded on the first call. */
export interface ZoneAdvisory { id: string; strong: boolean; title: string }
const ADV_RED: Record<Theme, string> = { dark: "#d24a37", light: "#9e2418" };
let zoneShapes: { type: "FeatureCollection"; features: { type: "Feature"; properties: { id: string; name: string }; geometry: unknown }[] } | null = null;
let zoneLoading: Promise<void> | null = null;
let zoneActive: ZoneAdvisory[] = [];
let zoneKey: string | null = null; // the zones last drawn, so an unchanged set is not redrawn

function applyZones(map: maplibregl.Map, th: Theme): void {
  if (!zoneShapes || !map.isStyleLoaded()) return;
  const data = {
    type: "FeatureCollection" as const,
    features: zoneShapes.features.flatMap((f) => {
      const a = zoneActive.find((z) => z.id === f.properties.id);
      return a ? [{ ...f, properties: { ...f.properties, strong: a.strong, title: a.title } }] : [];
    }),
  };
  const src = map.getSource("adv-zones") as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data as GeoJSON.FeatureCollection);
  else {
    map.addSource("adv-zones", { type: "geojson", data: data as GeoJSON.FeatureCollection });
    // A faint tint inside, so the zone reads as an area; the outline carries the kind.
    map.addLayer({ id: "adv-zones-fill", type: "fill", source: "adv-zones",
      paint: { "fill-color": ADV_RED[th], "fill-opacity": ["case", ["get", "strong"], 0.09, 0.05] } });
    map.addLayer({ id: "adv-zones-sc", type: "line", source: "adv-zones", filter: ["!", ["get", "strong"]],
      paint: { "line-color": ADV_RED[th], "line-width": 1.6, "line-dasharray": [3, 2], "line-opacity": 0.9 } });
    map.addLayer({ id: "adv-zones-gl", type: "line", source: "adv-zones", filter: ["get", "strong"],
      paint: { "line-color": ADV_RED[th], "line-width": 2.6, "line-opacity": 0.95 } });
  }
  for (const id of ["adv-zones-sc", "adv-zones-gl"]) if (map.getLayer(id)) map.setPaintProperty(id, "line-color", ADV_RED[th]);
  if (map.getLayer("adv-zones-fill")) map.setPaintProperty("adv-zones-fill", "fill-color", ADV_RED[th]);
}
onStyle((map, th) => applyZones(map, th));

/** Outline these zones (an empty list clears the map). */
export async function setAdvisoryZones(active: ZoneAdvisory[]): Promise<void> {
  // The time bar calls this on every step; replacing the source each time makes the tint and outline blink while the
  // map re-tiles it, so it is replaced only when the zones in force change.
  const key = active.map((z) => `${z.id}${z.strong ? "!" : ""}${z.title}`).sort().join("|");
  if (key === zoneKey) return;
  zoneActive = active;
  zoneLoading ??= fetch(ZONES_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => void (zoneShapes = j))
    .catch(() => undefined);
  await zoneLoading;
  const map = await mapReady();
  applyZones(map, theme);
  if (map.getSource("adv-zones") && zoneActive === active) zoneKey = key; // a later call may have overtaken this one
}

let select: (id: string) => void = () => {};

// Rivers: the basins (loaded once), the gauge markers while the view is on, and the highlighted basin.
interface Basins {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    id: string;
    // kind: "gauged" (above a gauge; id is the gauge's) or "watershed" (a river system to its mouth; id "WS-<system>")
    properties: { id: string; kind: "gauged" | "watershed"; watershed?: string };
    geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
  }[];
}
let basins: Basins | null = null;
let riverMode = false;
let gaugePins: Pin[] = [];
let gaugeMarkers: maplibregl.Marker[] = [];
let focused: string | null = null;

/** Switch the basemap to match the page theme (pins are HTML markers and survive; the basin layers are re-added). */
export function setMapTheme(next: Theme): void {
  theme = next;
  current?.setStyle(STYLES[next]);
}

/** Each pin's button and popup, by id, so pins can be updated in place (the timeline cursor moves often). */
const pinIndex = new Map<string, { el: HTMLElement; popup: maplibregl.Popup; pin: Pin; go: string }>();
/** A pin's label as plain text for its accessible name (the label is HTML: line breaks and entities). */
function labelText(p: Pin): string {
  const box = document.createElement("div");
  box.innerHTML = `${p.name}: ${p.label.replace(/<br>/g, "; ")}`;
  return box.textContent ?? "";
}
const pinClass = (p: Pin) => `pin pin-${p.state}${p.kind === "shore" ? " pin-shore" : p.kind === "gauge" ? " pin-gauge" : ""}`;

/** New labels and states for pins already on the map (unknown ids are ignored). */
export function updatePins(pins: Pin[]): void {
  for (const p of pins) {
    const entry = pinIndex.get(p.id);
    if (!entry) continue;
    // Swap the state class only: MapLibre's own marker classes on the same element place it.
    entry.el.classList.replace(`pin-${entry.pin.state}`, `pin-${p.state}`);
    entry.pin = { ...entry.pin, state: p.state, label: p.label, bar: p.bar };
    setBar(entry.el, p.bar);
    entry.el.setAttribute("aria-label", labelText(entry.pin));
    entry.popup.setHTML(`<b>${p.name}</b><br>${p.label}<br><span class="pin-go">${entry.go}</span>`);
  }
}

function marker(map: maplibregl.Map, p: Pin, go: string): maplibregl.Marker {
  const el = document.createElement("button");
  el.type = "button";
  el.className = pinClass(p);
  el.setAttribute("aria-label", labelText(p));
  el.innerHTML = `<span class="pin-bar" hidden></span><span class="pin-dot"></span><span class="pin-id">${p.id}</span>`;
  setBar(el, p.bar);
  const popup = new maplibregl.Popup({ offset: 14, closeButton: false, className: "pin-pop" }).setHTML(
    `<b>${p.name}</b><br>${p.label}<br><span class="pin-go">${go}</span>`,
  );
  el.addEventListener("mouseenter", () => {
    popup.setLngLat([p.lon, p.lat]).addTo(map);
    if (p.kind === "gauge") focusBasin(p.id);
  });
  el.addEventListener("mouseleave", () => popup.remove());
  // A pin's click is the pin's alone: the map under it would read it as a click on the water and open that spot's
  // readout. Its own label closes too (the map may move the pin from under the pointer).
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    popup.remove();
    select(p.id);
  });
  pinIndex.set(p.id, { el, popup, pin: p, go });
  return new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p.lon, p.lat]).addTo(map);
}

/** Draw the map: on the home view, or on `start` (a station's page opens on its station, without a flight), at its own
 * zoom where it gives one (a current meter's page opens close in, on its harbour). */
export function drawMap(container: HTMLElement, pins: Pin[], onSelect: (id: string) => void, initial: Theme, start?: { lon: number; lat: number; zoom?: number }): void {
  theme = initial;
  select = onSelect;
  const map = new maplibregl.Map({
    container,
    style: STYLES[initial],
    ...(start ? { center: [start.lon, start.lat] as [number, number], zoom: start.zoom ?? PLACE_ZOOM } : { bounds: HOME, fitBoundsOptions: { padding: container.clientWidth < 560 ? 6 : 24 } }),
    canvasContextAttributes: { preserveDrawingBuffer: true }, // Collect paints the map into its image
    // Credits behind the (i) button; set explicitly so they never depend on the style loading.
    attributionControl: {
      compact: true,
      // The basemap style carries its own credit (OpenFreeMap, OpenMapTiles, OpenStreetMap); add only the basins.
      customAttribution: 'Basins from <a href="https://waterdata.usgs.gov/blog/nldi-intro/">USGS NLDI</a>',
    },
    // With a mouse or trackpad the wheel zooms the map under the cursor (move off the map to scroll the page).
    // On a touch screen a one-finger drag scrolls the page and two fingers move the map, so a page scroll is
    // never trapped by a map that fills the width.
    cooperativeGestures: !window.matchMedia("(pointer: fine)").matches,
    dragRotate: false,
    pitchWithRotate: false,
  });
  current = map;
  map.touchZoomRotate.disableRotation();
  // Map credits stay behind the (i) button until asked for (MapLibre opens them on load by default).
  const collapse = () => container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  map.once("load", collapse);
  map.once("idle", collapse); // after the style's own credits arrive, which can re-open them
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  // The box takes the table's height, which changes with the view: redraw at the new size.
  new ResizeObserver(() => map.resize()).observe(container);
  // A new style (theme switch) drops custom layers: add the basins and the registered layers back.
  map.on("style.load", () => {
    addBasinLayers(map);
    for (const hook of styleHooks) hook(map, theme);
  });
  map.once("load", () => resolveReady(map));
  for (const p of pins) marker(map, p, "Go to station");
  if (riverMode) applyRiverMode(map);
}

function addBasinLayers(map: maplibregl.Map): void {
  if (!basins || map.getSource("basins")) return;
  map.addSource("basins", { type: "geojson", data: basins, promoteId: "id" });
  const hover = ["boolean", ["feature-state", "hover"], false] as maplibregl.ExpressionSpecification;
  const kind = (k: string) => ["==", ["get", "kind"], k] as maplibregl.FilterSpecification;
  const color = BASIN_COLOR[theme];
  // The watershed to the mouth: faint, with a dashed edge.
  map.addLayer({ id: "ws-fill", type: "fill", source: "basins", filter: kind("watershed"), paint: { "fill-color": color, "fill-opacity": ["case", hover, 0.12, 0.03] } });
  map.addLayer({
    id: "ws-line", type: "line", source: "basins", filter: kind("watershed"),
    paint: { "line-color": color, "line-width": ["case", hover, 1.4, 0.7], "line-opacity": ["case", hover, 0.9, 0.45], "line-dasharray": [3, 2] },
  });
  // The basin above the gauge (what its flow measures): an outline only. It lies inside the watershed, so a fill
  // of its own would stack into a darker shade; the solid edge and the gauge's triangle mark it instead.
  map.addLayer({
    id: "basin-line", type: "line", source: "basins", filter: kind("gauged"),
    paint: { "line-color": color, "line-width": ["case", hover, 2.2, 0.8], "line-opacity": ["case", hover, 1, 0.55] },
  });
  showBasins(map, riverMode);
  if (focused) highlight(map, focused, true);
}

const LAYERS = ["ws-fill", "ws-line", "basin-line"];
function showBasins(map: maplibregl.Map, on: boolean): void {
  for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/** The watershed a gauge's basin belongs to. */
const watershedOf = (id: string) => basins?.features.find((f) => f.properties.id === id)?.properties.watershed ?? null;

/** Mark (or unmark) a gauge's basin and its watershed. */
function highlight(map: maplibregl.Map, id: string, on: boolean): void {
  if (!map.getSource("basins")) return;
  for (const fid of [id, watershedOf(id)]) if (fid) map.setFeatureState({ source: "basins", id: fid }, { hover: on });
}

function applyRiverMode(map: maplibregl.Map): void {
  gaugeMarkers.forEach((m) => m.remove());
  gaugeMarkers = riverMode ? gaugePins.map((p) => marker(map, p, "Go to river")) : [];
  // The view stays where the reader left it: switching views never pans or zooms the map.
  const ready = () => {
    addBasinLayers(map);
    showBasins(map, riverMode);
  };
  if (map.isStyleLoaded()) ready();
  else map.once("load", ready);
}

/** Turn the Rivers view's map on or off: basins and gauge pins, over the map as the reader left it. */
export async function setRiverMode(on: boolean, gauges: Pin[]): Promise<void> {
  riverMode = on;
  gaugePins = gauges.map((g) => ({ ...g, kind: "gauge" }));
  if (on && !basins) {
    try {
      basins = (await (await fetch(BASINS_URL)).json()) as Basins;
    } catch {
      basins = null; // the gauges still show; the basins are a nicety
    }
  }
  if (!on) focusBasin(null);
  if (current) applyRiverMode(current);
}

/** Highlight one basin (or none). The map does not move: the reader pans and zooms it (drag, wheel or pinch). */
export function focusBasin(id: string | null): void {
  const map = current;
  if (!map) return;
  if (focused) highlight(map, focused, false);
  if (id) highlight(map, id, true);
  focused = id;
}
