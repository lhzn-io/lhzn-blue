/** The About page: its methods section is the text behind the page's (i) buttons (methods.ts), so the two never drift
 * apart. Each entry gets an anchor (/about/#comfort) that other pages link to. */
import "./landing";
import { comfortTableHtml, type Boat } from "./comfort-thresholds";
import { METHODS, methodHtml } from "./methods";

// The entries, in reading order: the comfort index and what feeds it, then the other layers and plots.
const ENTRIES = ["comfort", "map-comfort", "map-wat", "map-wind", "map-waves", "map-currents", "current-phase", "next48", "model", "advisory", "map-sst", "map-chl", "map-kd490"];
const ANCHOR: Record<string, string> = { comfort: "comfort", "map-comfort": "comfort-map", "map-wat": "wind-against-tide" };

const box = document.getElementById("about-methods");
if (box) {
  const ctx = { variable: "temperature", varKey: "temp", station: "the station", stationId: "", kind: "" };
  // The boat the Sound page remembers, for the comfort charts (the page's own setting; center console otherwise).
  let boat: Boat = "console";
  try {
    const b = localStorage.getItem("lhzn-blue-boat");
    if (b === "kayak" || b === "skiff" || b === "console" || b === "big") boat = b;
  } catch {
    /* private mode */
  }
  box.innerHTML = ENTRIES.filter((k) => METHODS[k])
    .map((k) => {
      const id = ANCHOR[k] ?? k;
      // Each entry's own closing line (times, provisional) is said once, under Conventions.
      const body = methodHtml(k, ctx).replace(/<p class="about-foot">.*?<\/p>$/, "");
      const charts = k === "comfort" ? comfortTableHtml(boat, false) : ""; // the thresholds the Method refers to
      return `<section class="about-entry" id="${id}" aria-labelledby="${id}-title"><h3 id="${id}-title">${METHODS[k].title}</h3>${body}${charts}</section>`;
    })
    .join("");
  // The charts' boat picker: redraw for the boat picked (here only; the Sound page keeps its own setting).
  box.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-boat]");
    const chart = box.querySelector(".comfort-chart");
    if (!b || !chart) return;
    chart.outerHTML = comfortTableHtml(b.dataset.boat as Boat, false);
  });
  // The anchors sit in entries drawn after the page loads; jump to the one asked for once they exist.
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
