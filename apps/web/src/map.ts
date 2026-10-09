/** Locator map: OpenFreeMap basemaps (OpenStreetMap data, no API key) with a bright pin per buoy (round) and
 * per shore station (square), dark or light to match the page theme. Loaded on demand so the rest of the page
 * does not wait for MapLibre. */
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";

export interface Pin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: "live" | "delayed" | "offline" | "partial"; // partial: weather live, water sensors offline
  kind?: "buoy" | "shore";
  label: string; // short reading for the popup, e.g. "Surface 66.3 F, 1 h ago"
}

const STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
} as const;

let current: maplibregl.Map | null = null;

/** Switch the basemap to match the page theme (pins are HTML markers, so they survive a style change). */
export function setMapTheme(theme: keyof typeof STYLES): void {
  current?.setStyle(STYLES[theme]);
}

export function drawMap(container: HTMLElement, pins: Pin[], onSelect: (id: string) => void, theme: keyof typeof STYLES): void {
  const map = new maplibregl.Map({
    container,
    style: STYLES[theme],
    bounds: [
      [-73.85, 40.72],
      [-72.05, 41.38],
    ],
    fitBoundsOptions: { padding: 24 },
    // Credits behind the (i) button; set explicitly so they never depend on the style loading.
    attributionControl: {
      compact: true,
      customAttribution:
        '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
        'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
  for (const p of pins) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `pin pin-${p.state}${p.kind === "shore" ? " pin-shore" : ""}`;
    el.setAttribute("aria-label", `${p.name}: ${p.label.replace(/<br>/g, "; ")}`);
    el.innerHTML = `<span class="pin-dot"></span><span class="pin-id">${p.id}</span>`;
    const popup = new maplibregl.Popup({ offset: 14, closeButton: false, className: "pin-pop" }).setHTML(
      `<b>${p.name}</b><br>${p.label}<br><span class="pin-go">Go to station</span>`,
    );
    el.addEventListener("mouseenter", () => popup.setLngLat([p.lon, p.lat]).addTo(map));
    el.addEventListener("mouseleave", () => popup.remove());
    el.addEventListener("click", () => onSelect(p.id));
    new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p.lon, p.lat]).addTo(map);
  }
}
