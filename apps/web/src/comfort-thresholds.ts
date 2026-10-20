/**
 * The small-craft comfort index's thresholds per boat class, shared by the index (fields.ts) and the table in its
 * About entry, so the two never drift apart. Steps run from Comfortable to Moderate, Uncomfortable and Discomfort.
 */

export type Boat = "kayak" | "skiff" | "console" | "big";

/** The classes in order, smallest first. */
export const BOAT_ORDER: Boat[] = ["kayak", "skiff", "console", "big"];

export interface BoatClass {
  name: string;
  /** A typical length, m (for the 30% breaking-wave rule). */
  loa: number;
  /** Sustained wind, kt. */
  wind: [number, number, number];
  /** Significant wave height, m. */
  hs: [number, number, number];
  /** Current, kt (paddle craft only). */
  current: [number, number, number] | null;
  /** The comfort level for each wave-current level, 0 to 4. */
  wat: [number, number, number, number, number];
  /** The least level while NWS has a small craft advisory in force. */
  sca: number;
}

export const COMFORT_WORDS = ["Comfortable", "Moderate", "Uncomfortable", "Discomfort"];

/** Line icons for the boat picker, drawn in the ink on a 28 x 14 box: a kayak with its paddle, a centre console, a
 * cabin cruiser. */
const BOAT_ICONS: Record<Boat, string> = {
  kayak: '<path d="M2 9.5Q14 13 26 9.5Q14 7.5 2 9.5Z"/><path d="M9 3.5L19 12.5M7.6 2.6l2.4 1.6M17.9 12l2.4 1.6"/><circle cx="14" cy="7.3" r="1.3"/>',
  skiff: '<path d="M4 8.5H24L22 12H6Z"/><path d="M24 8.5V5.5H26V10.5H24"/><path d="M12 8.5V6.8"/>',
  console: '<path d="M2 8.5H26L23 12.5H5Z"/><path d="M12 8.5V5.5H16.5V8.5M12 5.5L13.5 3H16.5"/>',
  big: '<path d="M1.5 8.5H26.5L23.5 12.5H4.5Z"/><path d="M7 8.5V4.8H18.5L21 8.5M9.5 6.5H12.5M14.5 6.5H17.5M12 4.8V2.5H15"/>',
};

/** A boat's line icon at a given height (the picker's at 14 px; the byline's smaller). */
export const boatIcon = (k: Boat, h = 14) =>
  `<svg viewBox="0 0 28 14" width="${2 * h}" height="${h}" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${BOAT_ICONS[k]}</g></svg>`;

/** "Center console, about 23 ft": the tooltip and label for a boat. */
export const boatLabel = (k: Boat) => `${BOATS[k].name}, about ${Math.round(BOATS[k].loa * 3.28084)} ft`;

/** The boat picker: four buttons with icons and short names, the chosen one pressed. Wired by the page (data-boat). */
export function boatPickerHtml(selected: Boat): string {
  const feet = (k: Boat) => `${Math.round(BOATS[k].loa * 3.28084)} ft`;
  return `<span class="boat-pick" role="radiogroup" aria-label="Boat for the comfort index">${BOAT_ORDER
    .map((k) => `<button type="button" role="radio" data-boat="${k}" aria-checked="${k === selected}" title="${boatLabel(k)}">${boatIcon(k)}<span>${feet(k)}</span></button>`)
    .join("")}</span>`;
}

export const BOATS: Record<Boat, BoatClass> = {
  // Lengths at regulatory breaks: 16 ft is the US Coast Guard's Class A limit; 7 m (23 ft) and 12 m (39 ft) are COLREGS'.
  kayak: { name: "Kayak", loa: 3.7, wind: [8, 12, 15], hs: [0.15, 0.3, 0.5], current: [0.5, 1, 2], wat: [0, 2, 3, 3, 3], sca: 3 },
  skiff: { name: "Skiff", loa: 4.9, wind: [10, 13, 18], hs: [0.2, 0.45, 0.75], current: null, wat: [0, 2, 3, 3, 3], sca: 3 },
  // Discomfort at the small craft advisory: 20 kt is NWS Eastern Region's lower advisory criterion for waters busy with
  // small craft, and an advisory in force makes it Discomfort outright.
  console: { name: "Center console", loa: 7.0, wind: [10, 15, 20], hs: [0.3, 0.6, 1.0], current: null, wat: [0, 1, 2, 3, 3], sca: 3 },
  big: { name: "Cruiser", loa: 9.1, wind: [10, 15, 25], hs: [0.5, 1.0, 1.5], current: null, wat: [0, 1, 2, 3, 3], sca: 1 },
};

/** The thresholds as strip charts for the About entry: for each factor, a bar per boat class along a shared axis,
 * shaded from Comfortable (palest) to Discomfort (darkest) as in the cell view's comfort band; the reader's boat is
 * marked. The rules that raise the level follow in one line. Heights in feet or metres. */
export function comfortTableHtml(selected: Boat, metric: boolean): string {
  const order = BOAT_ORDER;
  const W = 560;
  const L = 140; // label column
  const shade = [0.05, 0.2, 0.45, 0.85];
  const strip = (title: string, top: number, ticks: number[], steps: (b: BoatClass) => number[] | null, fmt: (v: number) => string) => {
    const x = (v: number) => L + (Math.min(v, top) / top) * (W - L - 8);
    const rows = order.filter((k) => steps(BOATS[k]));
    const H = 18 + rows.length * 21 + 12;
    let g = `<text x="0" y="11" class="ct-title">${title}</text>`;
    rows.forEach((k, r) => {
      const y = 24 + r * 21; // room above each bar for its step labels
      const st = steps(BOATS[k])!;
      const edges = [0, ...st, top];
      g += `<text x="0" y="${y + 9}" class="ct-name${k === selected ? " sel" : ""}">${BOATS[k].name}</text>`;
      for (let i = 0; i < 4; i++) g += `<rect x="${x(edges[i]).toFixed(1)}" y="${y}" width="${(x(edges[i + 1]) - x(edges[i])).toFixed(1)}" height="10" fill="currentColor" fill-opacity="${shade[i]}"/>`;
      st.forEach((v) => (g += `<text x="${x(v).toFixed(1)}" y="${y - 2.5}" class="ct-step${k === selected ? " sel" : ""}">${fmt(v)}</text>`));
    });
    const ya = 24 + rows.length * 21 - 1;
    g += ticks.map((v) => `<text x="${x(v).toFixed(1)}" y="${ya}" class="ct-tick">${fmt(v)}</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="comfort-strip" role="img" aria-label="${title} thresholds by boat">${g}</svg>`;
  };
  const ft = (m: number) => (metric ? +m.toFixed(2) : +(m * 3.28084).toFixed(1));
  const legend = `<p class="ct-legend">${COMFORT_WORDS.map((w, i) => `<span><i style="opacity:${shade[i] + 0.05}"></i>${w}</span>`).join("")}</p>`;
  const b = BOATS[selected];
  const rules =
    `<p class="ct-rules">Discomfort (3) also with a small craft advisory (cruiser: Moderate), a gale warning, three uncomfortable factors, ` +
    `or breaking waves of 30% of your length (${metric ? `${(0.3 * b.loa).toFixed(1)} m` : `${(0.3 * b.loa * 3.28084).toFixed(0)} ft`}). ` +
    `Water under 15 C (59 F) adds a level; steepening seas count as moderate (kayak and skiff: uncomfortable).</p>`;
  return `<div class="comfort-chart"><div class="ct-top">${boatPickerHtml(selected)}${legend}</div>` +
    strip("Wind, kt", 30, [0, 10, 20, 30], (x) => x.wind, (v) => `${v}`) +
    strip(`Waves, ${metric ? "m" : "ft"}`, metric ? 2 : 6, metric ? [0, 0.5, 1, 1.5, 2] : [0, 2, 4, 6], (x) => x.hs.map(ft), (v) => `${v}`) +
    strip("Current, kt", 3, [0, 1, 2, 3], (x) => x.current, (v) => `${v}`) +
    rules + `</div>`;
}
