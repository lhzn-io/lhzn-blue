/** The comfort index's methodology page (/about/comfort-index/): the formula for the boat chosen, and a worked example
 * from one hour's model values at WLIS. Both are built from the index's own constants and rules (comfort-thresholds.ts),
 * so the page's arithmetic is the index's: the example's result is comfortLevel's, and its steps are drawn from the
 * same branches. The (i) on the comfort entry stays short and links here. */
import "./landing";
import { BOATS, BOAT_ORDER, COMFORT_WORDS, boatPickerHtml, comfortLevel, stepLevel, stepScore, type Boat } from "./comfort-thresholds";

const FT = 3.28084;
const r2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** One block per line, each wrapping under its own hanging indent on a narrow screen. */
const pre = (lines: string[]) => `<pre class="ci-pre">${lines.map((s) => `<span>${s ? esc(s) : "&nbsp;"}</span>`).join("")}</pre>`;

/** The formula for a boat: inputs, the step score, its factors with their steps, and how they combine. */
function formulaLines(boat: Boat): string[] {
  const b = BOATS[boat];
  const kayak = boat === "kayak";
  const breakH = (0.3 * b.loa) / 1.8; // the Hs at which 1.8 Hs reaches 30% of the length
  return [
    `INPUTS, at a point and hour t`,
    `  W   HRRR sustained wind at 10 m, kt: the nearest 3 km cell, linear between hourly frames`,
    `  H   NWPS significant wave height, m: the nearest 1.8 km water cell within 2 km (none on shore cells)`,
    ...(b.current ? [`  C   NECOFS surface current speed, kt: the nearest element within 2 km, linear between 2-hourly steps`] : []),
    `  L   wind against tide, level 0 to 4, on the wave model's grid: the nearest 2-hourly frame within an hour`,
    `      (0 none, 1 steepening, 2 steep seas, 3 breaking seas, 4 waves blocked)`,
    `  A   NWS advisory for the point's zone at t: 0 none, 1 small craft, 2 gale or worse (a click's readout only)`,
    ...(kayak
      ? [`  Ta  HRRR air temperature at 2 m, F: the nearest forecast station`, `  Tw  MUR sea surface temperature, F: the point's 1 km pixel`]
      : []),
    ``,
    `STEP SCORE f(v), against steps s1 < s2 < s3`,
    `  v < s1        f = v / s1`,
    `  s1 <= v < s2  f = 1 + (v-s1)/(s2-s1)`,
    `  s2 <= v < s3  f = 2 + (v-s2)/(s3-s2)`,
    `  v >= s3       f = 3 + min(3.99, (v-s3)/(0.5 s3))`,
    `  level = floor(min(f, 3)): 0 Comfortable, 1 Moderate, 2 Uncomfortable, 3 Discomfort`,
    ``,
    `FACTORS for a ${b.name.toLowerCase()} (length ${b.loa} m, ${Math.round(b.loa * FT)} ft); a factor without data is left out`,
    `  wind      f(W), steps ${b.wind.join(", ")} kt`,
    `  waves     f(H), steps ${b.hs.join(", ")} m`,
    ...(b.current ? [`  current   f(C), steps ${b.current.join(", ")} kt`] : []),
    `  against   score = level = [${b.wat.join(", ")}][L]  (wind against tide)`,
    `  30% rule  3 when L >= 3 and 1.8 H >= 0.3 length (H >= ${r2(breakH)} m)`,
    ``,
    `COMBINE`,
    `  S = the largest factor score;  K = the largest factor level`,
    `  three or more factors at level 2 or more:  K = 3,  S = max(S, 3)`,
    `  advisory (readout only):  a = ${b.sca} for a small craft advisory, 3 for a gale or worse;  K = max(K, a),  S = max(S, a)`,
    ...(kayak
      ? [`  cold, the paddlers' 120 rule:  if Ta + Tw < 120 F (without Ta: Tw < 59 F; without Tw, no step) and K < 3:  K = K + 1,  S = S + 1`]
      : [`  water temperature is not an input for this boat (for a kayak, the paddlers' 120 rule adds a level)`]),
    `  index = min(S, 6.99),  read as [Comfortable, Moderate, Uncomfortable, Discomfort][K]`,
    `  the map shades S per wave cell, without the advisory; beyond HRRR's 48 hours, no index`,
  ];
}

/** The worked example's inputs: WLIS on 2026-11-14 at 4 PM EST (21:00 UTC), a marginally uncomfortable hour for a
 * center console. Model values as the index read them then (HRRR at the WLIS point; the map's cell may differ by a few
 * tenths). Wind against tide was 0 and no advisory was in force for the zone (ANZ335's last small craft advisory ended
 * 2026-11-13 at 23:00 UTC). The current and the water temperature are not needed: see the kayak's note. */
const EX = {
  where: "WLIS, the western Sound buoy (40.96 N, 73.58 W)",
  when: "Saturday, November 14, 2026, 4 PM EST (21:00 UTC)",
  W: 15.1, // kt, HRRR 20Z run, lead 1 h
  H: 0.35, // m, NWPS 12Z run, step 9 h (peak period 2.3 s)
  L: 0,
  A: 0,
  airF: 46.5, // F, HRRR 2 m
  sources: [
    ["W", "15.1 kt", "HRRR, the 20Z run at 1 hour (gusts 19.1 kt, which the index does not use)"],
    ["H", "0.35 m (1.1 ft)", "NWPS, the 12Z run at 9 hours; peak period 2.3 s"],
    ["L", "0", "the 21Z wind-against-tide frame: no wind against tide in the WLIS cell"],
    ["A", "0", "no advisory in force for zone ANZ335 (the last small craft advisory ended Nov 13, 23Z)"],
    ["Ta", "46.5 F", "HRRR air temperature at 2 m (a kayak's input only)"],
  ] as [string, string, string][],
};

/** One factor's step score, with the branch it falls in and the arithmetic. */
function stepLine(label: string, sym: string, v: number, s: number[], unit: string): string {
  const f = stepScore(v, s);
  const lv = stepLevel(v, s);
  const fmt = (x: number) => `${+x.toFixed(2)}`;
  const arith =
    v < s[0] ? `${sym} < s1: f = ${fmt(v)} / ${fmt(s[0])}`
    : v < s[1] ? `s1 <= ${sym} < s2: f = 1 + (${fmt(v)} - ${fmt(s[0])}) / (${fmt(s[1])} - ${fmt(s[0])})`
    : v < s[2] ? `s2 <= ${sym} < s3: f = 2 + (${fmt(v)} - ${fmt(s[1])}) / (${fmt(s[2])} - ${fmt(s[1])})`
    : `${sym} >= s3: f = 3 + min(3.99, (${fmt(v)} - ${fmt(s[2])}) / (0.5 x ${fmt(s[2])}))`;
  return `  ${label.padEnd(9)} ${sym} = ${fmt(v)} ${unit}, steps ${s.join(", ")}:  ${arith} = ${r2(f)},  level ${lv} (${COMFORT_WORDS[lv]})`;
}

/** The example worked through for one boat, step by step; the result line is comfortLevel's own. */
function exampleLines(boat: Boat): string[] {
  const b = BOATS[boat];
  const out: string[] = [`${b.name.toUpperCase()}`];
  const scores: [string, number, number][] = [];
  out.push(stepLine("wind", "W", EX.W, b.wind, "kt"));
  scores.push(["wind", stepScore(EX.W, b.wind), stepLevel(EX.W, b.wind)]);
  out.push(stepLine("waves", "H", EX.H, b.hs, "m"));
  scores.push(["waves", stepScore(EX.H, b.hs), stepLevel(EX.H, b.hs)]);
  if (b.current) out.push(`  current   C: not read for this example (see below)`);
  out.push(EX.L > 0 ? `  against   L = ${EX.L}:  [${b.wat.join(", ")}][${EX.L}] = ${b.wat[EX.L]}` : `  against   L = 0: no wind against tide, so not a factor`);
  if (EX.L > 0) scores.push(["against", b.wat[EX.L], b.wat[EX.L]]);
  out.push(`  30% rule  L = ${EX.L} < 3: does not apply`);
  const S = Math.max(...scores.map((x) => x[1]));
  const K = Math.max(...scores.map((x) => x[2]));
  out.push(``, `  S = max(${scores.map((x) => r2(x[1])).join(", ")}) = ${r2(S)};  K = max(${scores.map((x) => x[2]).join(", ")}) = ${K}`);
  const hi = scores.filter((x) => x[2] >= 2).length;
  out.push(`  factors at level 2 or more: ${hi}${hi >= 3 ? ": K = 3" : ", fewer than three: no change"}`);
  out.push(`  advisory: A = ${EX.A}: no floor`);
  if (boat === "kayak") out.push(K >= 3 ? `  cold (120 rule): K is already 3: no step, whatever the air and water` : `  cold (120 rule): needs Tw (not read for this example)`);
  else out.push(`  water temperature: not an input for this boat`);
  // The index's own function, on the same inputs: the line below is its result, not this page's.
  const c = comfortLevel({ kt: EX.W, hs: EX.H, curKt: NaN, wl: EX.L, sst: NaN, airF: EX.airF }, boat);
  if (c) out.push(``, `  index = ${r2(c.score)}:  ${COMFORT_WORDS[c.level]}, set by the ${scores.reduce((a, x) => (x[1] > a[1] ? x : a))[0]}`);
  return out;
}

function render(root: HTMLElement, boat: Boat): void {
  const b = BOATS[boat];
  root.innerHTML = `
    <h2 id="formula">The formula</h2>
    <p class="prose">For the boat chosen; the steps are judgements for typical boats of each length, not a standard.</p>
    <div class="ci-boats">${boatPickerHtml(boat)}</div>
    ${pre(formulaLines(boat))}
    <h2 id="example">Worked example: a marginally uncomfortable hour</h2>
    <p class="prose">${EX.where}, ${EX.when}. A wind just past 15 kt with a short, low chop: for a center console, the
    wind sits just over its Uncomfortable step and the waves in Moderate. The inputs, as the index read them at that hour:</p>
    <table class="ci-inputs"><tbody>${EX.sources.map(([k, v, s]) => `<tr><th>${k}</th><td>${v}</td><td>${s}</td></tr>`).join("")}</tbody></table>
    ${pre(exampleLines("console"))}
    <p class="prose">The same hour for a kayak: the wind alone is past its Discomfort step (15 kt), so the index is Discomfort before the
    current or the cold is looked at. A current would raise the score only above 2 kt, and the 120 rule adds a level only below
    Discomfort, so neither is read here.</p>
    ${pre(exampleLines("kayak"))}
    ${boat !== "console" && boat !== "kayak" ? `<p class="prose">For a ${b.name.toLowerCase()} the same hour reads:</p>${pre(exampleLines(boat))}` : ""}
    <p class="prose">The result lines are computed by the index's own rules on these inputs, so the page and the map cannot disagree.
    The code is open source: <a href="https://github.com/lhzn-io/lhzn-blue/blob/main/apps/web/src/comfort-thresholds.ts">comfort-thresholds.ts</a>.</p>`;
}

const root = document.getElementById("ci-root");
if (root) {
  let boat: Boat = "console";
  try {
    const s = localStorage.getItem("lhzn-blue-boat");
    if (s && (BOAT_ORDER as string[]).includes(s)) boat = s as Boat;
  } catch {
    /* private mode */
  }
  render(root, boat);
  root.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-boat]");
    if (btn) render(root, btn.dataset.boat as Boat);
  });
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
