/** Locator map: OpenFreeMap basemaps (OpenStreetMap data, no API key) with a bright pin per buoy (round) and
 * per shore station (square), dark or light to match the page theme. In the Rivers view it shows each river's
 * watershed down to its mouth on the Sound (faint, dashed) and, within it, the basin above the gauge (what the
 * gauge's flow measures), with a triangle at the gauge; pointing at a river highlights both and fits the map to
 * the watershed. Basins from USGS NLDI, simplified. Loaded on demand so the rest of the page does not wait for
 * MapLibre. */
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";

type PinState = "live" | "delayed" | "offline" | "partial"; // partial: weather live, water sensors offline

export interface Pin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: PinState;
  kind?: "buoy" | "shore" | "gauge";
  label: string; // short reading for the popup, e.g. "Surface 66.3 F, 1 h ago"
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

function marker(map: maplibregl.Map, p: Pin, go: string): maplibregl.Marker {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `pin pin-${p.state}${p.kind === "shore" ? " pin-shore" : p.kind === "gauge" ? " pin-gauge" : ""}`;
  el.setAttribute("aria-label", `${p.name}: ${p.label.replace(/<br>/g, "; ")}`);
  el.innerHTML = `<span class="pin-dot"></span><span class="pin-id">${p.id}</span>`;
  const popup = new maplibregl.Popup({ offset: 14, closeButton: false, className: "pin-pop" }).setHTML(
    `<b>${p.name}</b><br>${p.label}<br><span class="pin-go">${go}</span>`,
  );
  el.addEventListener("mouseenter", () => {
    popup.setLngLat([p.lon, p.lat]).addTo(map);
    if (p.kind === "gauge") focusBasin(p.id, false);
  });
  el.addEventListener("mouseleave", () => popup.remove());
  el.addEventListener("click", () => select(p.id));
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
    // Credits behind the (i) button; set explicitly so they never depend on the style loading.
    attributionControl: {
      compact: true,
      customAttribution:
        '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
        'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>; basins from ' +
        '<a href="https://waterdata.usgs.gov/blog/nldi-intro/">USGS NLDI</a>',
    },
    cooperativeGestures: true, // a page scroll never gets trapped by the map
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
  // A new style (theme switch) drops custom layers: add the basins back.
  map.on("style.load", () => addBasinLayers(map));
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

/** Bounds of a gauge's watershed (so the river's mouth is in view), or of every watershed. */
function bounds(id: string | null): maplibregl.LngLatBounds | null {
  if (!basins) return null;
  const want = id ? watershedOf(id) ?? id : null;
  const b = new maplibregl.LngLatBounds();
  for (const f of basins.features) {
    if (want ? f.properties.id !== want : f.properties.kind !== "watershed") continue;
    for (const poly of f.geometry.coordinates) for (const [x, y] of poly[0]) b.extend([x, y]);
  }
  return b.isEmpty() ? null : b;
}

function applyRiverMode(map: maplibregl.Map): void {
  gaugeMarkers.forEach((m) => m.remove());
  gaugeMarkers = riverMode ? gaugePins.map((p) => marker(map, p, "Go to river")) : [];
  const ready = () => {
    addBasinLayers(map);
    showBasins(map, riverMode);
    const b = riverMode ? bounds(null) : null;
    map.fitBounds(b ?? HOME, { padding: 24, duration: 600 });
  };
  if (map.isStyleLoaded()) ready();
  else map.once("load", ready);
}

/** Turn the Rivers view's map on or off: basins and gauges, fitted to the whole watershed; off returns to the Sound. */
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
  if (!on) focusBasin(null, false);
  if (current) applyRiverMode(current);
}

/** Highlight one basin (or none) and, unless told not to, fit the map to it (or back to all basins). */
export function focusBasin(id: string | null, fit = true): void {
  const map = current;
  if (!map) return;
  if (focused) highlight(map, focused, false);
  if (id) highlight(map, id, true);
  focused = id;
  if (fit && riverMode) {
    const b = bounds(id);
    if (b) map.fitBounds(b, { padding: 28, duration: 700, maxZoom: 10 });
  }
}
