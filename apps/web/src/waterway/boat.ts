/** The boat the comfort index is drawn for: the menu's picker, the chosen boat's icon in the byline, and every other
 * picker on the page (the comfort charts'); kept in this browser. Read `BOAT` live. */
import type { Boat } from "../fields";
import { BOATS, boatIcon, boatLabel, boatPickerHtml, comfortTableHtml } from "../comfort-thresholds";
import { WU } from "./units";

/** The boat class for the comfort index (the menu's Boat setting): paddle craft, small boat (5 to 8 m, the default),
 * large boat (8 to 15 m); kept in this browser. */
export let BOAT: Boat = (() => {
  try {
    const b = localStorage.getItem("lhzn-blue-boat");
    // Earlier saved choices (paddle craft, small boat, large boat) map to the nearest class.
    const old: Record<string, Boat> = { paddle: "kayak", small: "console", large: "big" };
    return b === "kayak" || b === "skiff" || b === "console" || b === "big" ? b : old[b ?? ""] ?? "console";
  } catch {
    return "console";
  }
})();
/** The boat picker in the menu and in the comfort charts: one listener for every picker on the page. */
export function wireBoat(onChange: () => void): void {
  const slot = document.querySelector("[data-boat-slot]");
  if (slot) slot.insertAdjacentHTML("beforeend", boatPickerHtml(BOAT));
  // Up front, in the byline: the chosen boat's icon (its name and length as the tooltip); a click opens the picker.
  const mast = document.querySelector<HTMLElement>("[data-boat-mast]");
  const chip = () => `${BOATS[BOAT].name} \u00b7 ${Math.round(BOATS[BOAT].loa * 3.28084)} ft`;
  const spoken = () => `Boat for the comfort index: ${boatLabel(BOAT)}`;
  if (mast) {
    mast.innerHTML = `<button type="button" class="boat-now" aria-haspopup="true" aria-expanded="false" title="${chip()}" aria-label="${spoken()}">${boatIcon(BOAT, 12)}</button>` +
      `<span class="boat-pop" hidden>${boatPickerHtml(BOAT)}</span>`;
  }
  const now = mast?.querySelector<HTMLButtonElement>(".boat-now");
  const pop = mast?.querySelector<HTMLElement>(".boat-pop");
  const openPop = (open: boolean) => {
    if (!pop || !now) return;
    pop.hidden = !open;
    now.setAttribute("aria-expanded", String(open));
  };
  now?.addEventListener("click", () => openPop(!!pop?.hidden));
  document.addEventListener("click", (e) => {
    if (pop && !pop.hidden && !(e.target as Element).closest?.("[data-boat-mast]")) openPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop && !pop.hidden) {
      openPop(false);
      now?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    const b = (e.target as Element).closest?.("button[data-boat]") as HTMLButtonElement | null;
    if (!b) return;
    e.stopPropagation(); // the menu stays open
    BOAT = b.dataset.boat as typeof BOAT;
    try {
      localStorage.setItem("lhzn-blue-boat", BOAT);
    } catch {
      /* private mode: for this visit */
    }
    document.querySelectorAll<HTMLButtonElement>("button[data-boat]").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.boat === BOAT)));
    if (now) {
      now.innerHTML = boatIcon(BOAT, 12);
      now.title = chip();
      now.setAttribute("aria-label", spoken());
    }
    if (b.closest("[data-boat-mast]")) openPop(false);
    // The comfort charts, if open, redraw for the new boat.
    const chart = document.querySelector("#about-dialog-body .comfort-chart");
    if (chart) chart.outerHTML = comfortTableHtml(BOAT, WU === "ms");
    onChange(); // the comfort layer, drawn for the new boat
  });
}
