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

/** The Sound, the map's home view. */
const HOME: maplibregl.LngLatBoundsLike = [
  [-73.85, 40.72],
  [-72.05, 41.38],
];
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

/** The page theme the map is drawn in. */
export const mapTheme = (): Theme => theme;
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
  el.addEventListener("click", () => select(p.id));
  pinIndex.set(p.id, { el, popup, pin: p, go });
  return new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p.lon, p.lat]).addTo(map);
}

export function drawMap(container: HTMLElement, pins: Pin[], onSelect: (id: string) => void, initial: Theme): void {
  theme = initial;
  select = onSelect;
  const map = new maplibregl.Map({
    container,
    style: STYLES[initial],
    bounds: HOME,
    fitBoundsOptions: { padding: 24 },
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
      basins = (await (await fetch("/basins.geojson")).json()) as Basins;
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
