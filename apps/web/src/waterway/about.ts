/** The About dialog: a station's own About (from the page), or one entry from methods.ts for a plot, a readout or a map
 * layer, with a link to the plot where there is one. */
import { METHODS, methodHtml } from "../methods";
import type { StationData } from "./station-data";

const $ = (id: string) => document.getElementById(id)!;

/** What the page supplies: a station's About, a plot's link, and the words an entry fills in. */
export interface AboutHost {
  station(d: StationData): { title: string; html: string };
  link(key: string, d: StationData | null): string; // "" where there is no plot to link to
  method(d: StationData | null): Parameters<typeof methodHtml>[1];
  extend?(key: string, body: HTMLElement, d: StationData | null): void; // anything an entry adds below itself
}
let A: AboutHost;
let aboutLink = "";

export function openAbout(key: string, d: StationData | null): void {
  if (key === "station" && d) {
    const dialog = $("about-dialog") as HTMLDialogElement;
    aboutLink = "";
    ($("about-link") as HTMLButtonElement).hidden = true;
    const about = A.station(d);
    $("about-dialog-title").textContent = about.title;
    $("about-dialog-body").innerHTML = about.html;
    if (!dialog.open) dialog.showModal();
    return;
  }
  const m = METHODS[key];
  if (!m) return;
  const dialog = $("about-dialog") as HTMLDialogElement;
  aboutLink = A.link(key, d);
  const linkBtn = $("about-link") as HTMLButtonElement;
  linkBtn.hidden = !aboutLink;
  linkBtn.textContent = "Copy link";
  $("about-dialog-title").textContent = d && !key.startsWith("map-") ? `${m.title}: ${d.meta.name}` : m.title;
  $("about-dialog-body").innerHTML = methodHtml(key, A.method(d));
  A.extend?.(key, $("about-dialog-body"), d);
  if (!dialog.open) dialog.showModal();
}

export function wireAbout(host: AboutHost): void {
  A = host;
  const dialog = $("about-dialog") as HTMLDialogElement;
  $("about-close").addEventListener("click", () => dialog.close());
  // A link to a section of this page (the river list in the gauges' About) closes the dialog on the way.
  $("about-dialog-body").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest('a[href^="#"]')) dialog.close();
  });
  $("about-link").addEventListener("click", async () => {
    const btn = $("about-link") as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(aboutLink);
      btn.textContent = "Copied";
    } catch {
      window.prompt("Copy this link:", aboutLink); // clipboard refused: show it to copy by hand
    }
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
  // The map key's (i) (fields.ts) asks for its layer's entry.
  document.addEventListener("lhzn-about", (e) => openAbout((e as CustomEvent<{ key: string }>).detail.key, null));
}
