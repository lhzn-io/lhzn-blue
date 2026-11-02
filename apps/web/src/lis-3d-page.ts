/**
 * "Currents in 3D" (/long-island-sound/currents-3d/): the NECOFS model's currents in a three.js pane
 * (public/long-island-sound/currents-3d/pane/), one place at a time: the whole Sound (its surface and bottom layers,
 * and a full-depth section along its axis) or the eastern Sound (every layer, New London to The Race and Plum Gut).
 * The page owns the clock: one slider (and a play button) steps the pane through the model's hourly records, and a
 * change of place keeps the hour. `?place=east` opens the eastern Sound.
 *
 * Data: v1/lis-pane/sound/ and v1/lis-pane/ (window.bin, mesh.json, nodes.f32, tri.u16; the whole Sound's section.bin),
 * written daily by the jobs' lis_pane module.
 */
import "./site.css";
import "./away-links";
import "./models-page.css";
import "./lis-3d-page.css";
import { setPlayButton, timeTrack } from "./time-axis";

const PANE_BASE = "/long-island-sound/currents-3d/pane/"; // the module; its data come from the Worker (Workers KV)
const $ = (id: string) => document.getElementById(id)!;
const TZ = "America/New_York";
const PLAY_MS = 700;
const HOUR = 3600;

interface Pane {
  setTime(t: number): void;
  setTheme(light: boolean): void;
  setUnits(unit: "kt" | "mph" | "ms"): void;
  dispose(): void;
}
interface PaneOpts {
  dataBase: string;
  title?: boolean;
  place?: Record<string, unknown>;
  onReady?: (range: { t0: number; t1: number }) => void;
}

/** The places: where each one's data are, and what the pane needs to know before they load. */
const PLACES = {
  sound: {
    label: "Whole Sound",
    data: "/data/v1/lis-pane/sound/",
    lede: "Long Island Sound from Throgs Neck to Block Island Sound: the NECOFS model's surface and bottom currents, and its full depth along the Sound's axis, hourly, from five days back to two days ahead.",
    place: {
      title: "Long Island Sound, 3D",
      allLayers: false,
      exag: 100,
      exagMax: 200,
      view: { bearing: 165, horiz: 95000, height: 125000, far: 900000, narrow: 2.6 }, // a phone sees the whole length
      curtains: {
        axis: { section: true, name: "Along the Sound", pos: "flood", neg: "ebb", posTo: "toward Throgs Neck", negTo: "toward The Race" },
      },
      curtainNote:
        "Along the Sound: every layer of the elements on a line from Throgs Neck through the western, central and eastern basins to The Race, coloured by the current along the line.",
      boxNote: "The map's box, from Throgs Neck to Block Island Sound and 20 km of the ocean.",
    },
  },
  east: {
    label: "Eastern Sound",
    data: "/data/v1/lis-pane/",
    lede: "The eastern Sound from New London to The Race and Plum Gut, 21 by 28 km: the NECOFS model's currents at all 45 layers, hourly, from five days back to two days ahead.",
    place: {
      title: "Eastern Long Island Sound, 3D",
      exag: 40,
      exagMax: 80,
      curtainNote:
        "Across The Race: a line at 19 deg through its middle, coloured by the flow toward 289 deg. Along the Thames: a line at 337 deg through the meter. Each bearing is the model's principal axis of depth-mean flow over the window at the line's middle element.",
      boxNote: "Box 21 by 28 km, from New London to The Race and Plum Gut.",
    },
  },
} as const;
type PlaceKey = keyof typeof PLACES;

const fmtDay = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtEastern = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TZ });
const hourUtc = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
const light = () => document.documentElement.dataset.theme === "light";

let mod: { mountPane: (el: HTMLElement, o: PaneOpts) => Pane } | null = null;
let PANE: Pane | null = null;
let T0 = 0;
let N = 0;
let T: number | null = null;
let track: { redraw: () => void } | null = null;

function setTime(t: number): void {
  T = t;
  ($("slider") as HTMLInputElement).value = String((t - T0) / HOUR);
  const d = new Date(t * 1000);
  $("tlabel").innerHTML = `<b>${fmtDay.format(d)}, ${hourUtc(d)}</b> (${fmtEastern.format(d)} Eastern)${t > Date.now() / 1000 ? ", forecast" : ""}`;
  PANE?.setTime(t);
}

let timer = 0;
function setPlaying(on: boolean): void {
  window.clearInterval(timer);
  setPlayButton($("play"), on);
  if (on) timer = window.setInterval(() => setTime(T0 + ((Math.round(((T ?? T0) - T0) / HOUR) + 1) % N) * HOUR), PLAY_MS);
}

function wireTheme(redraw: () => void): void {
  const btn = $("theme-toggle");
  const MOON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const SUN = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const label = () => {
    btn.innerHTML = light() ? MOON : SUN;
    btn.title = light() ? "Dark theme" : "Light theme";
    btn.setAttribute("aria-pressed", String(light()));
    btn.setAttribute("aria-label", light() ? "Switch to the dark theme" : "Switch to the light theme");
  };
  label();
  btn.addEventListener("click", () => {
    const next = light() ? "dark" : "light";
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("lhzn-blue-theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    label();
    redraw();
  });
}

function failed(text: string): void {
  const e = $("load-error");
  e.hidden = false;
  e.textContent = text;
  $("controls").hidden = true;
}

/** Mount a place's pane in place of the current one, keeping the hour when the new window holds it. */
function showPlace(key: PlaceKey): void {
  if (!mod) return;
  const p = PLACES[key];
  setPlaying(false);
  PANE?.dispose();
  $("controls").hidden = true;
  $("lede").textContent = p.lede;
  $("pane3d").setAttribute("aria-label", `3D view of the model's currents: ${p.label.toLowerCase()}`);
  document.querySelectorAll<HTMLButtonElement>("[data-place]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.place === key)));
  const url = new URL(location.href);
  if (key === "sound") url.searchParams.delete("place");
  else url.searchParams.set("place", key);
  history.replaceState(null, "", url);
  PANE = mod.mountPane($("pane3d"), {
    dataBase: p.data,
    title: false,
    place: p.place,
    onReady: ({ t0, t1 }) => {
      T0 = t0;
      N = Math.round((t1 - t0) / HOUR) + 1;
      const slider = $("slider") as HTMLInputElement;
      slider.max = String(N - 1);
      if (!track) {
        track = timeTrack(slider, (v) => T0 + Math.round(v) * HOUR);
        slider.addEventListener("input", () => {
          setPlaying(false);
          setTime(T0 + Number(slider.value) * HOUR);
        });
        $("play").addEventListener("click", () => setPlaying($("play").getAttribute("aria-pressed") !== "true"));
      } else track.redraw();
      $("controls").hidden = false;
      // The hour already shown if this window holds it, else the latest hour at or before now.
      const now = Math.min(t1, Math.max(t0, t0 + Math.floor((Date.now() / 1000 - t0) / HOUR) * HOUR));
      setTime(T !== null && T >= t0 && T <= t1 ? T : now);
    },
  });
  PANE.setTheme(light());
  PANE.setUnits("kt");
}

async function main(): Promise<void> {
  wireTheme(() => PANE?.setTheme(light()));
  $("controls").hidden = true; // until the pane knows its hours
  try {
    mod = (await import(/* @vite-ignore */ `${PANE_BASE}pane.js`)) as typeof mod;
  } catch {
    return failed("The 3D view could not load.");
  }
  document.querySelectorAll<HTMLButtonElement>("[data-place]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-pressed") !== "true") showPlace(b.dataset.place as PlaceKey);
    }),
  );
  const asked = new URLSearchParams(location.search).get("place");
  showPlace(asked && asked in PLACES ? (asked as PlaceKey) : "sound");
}

void main();
