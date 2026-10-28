/** Bring your own AI: the prompt a visitor copies (the page's template filled with every station's data, or only the
 * collected items' stations, with their methods, the readouts and the map as shown) and the Collect tray it comes from.
 * The page supplies its template, its map layer, its links and its credit. */
import { mountCollect } from "../collect";
import { METHODS, REF_LABELS } from "../methods";
import { compass } from "../wind-dir";
import { COVERAGE_MIN, DAY, fToC, grid, oxygenStatus, STRAT, yearLines, type Live, type Meta } from "../series";
import { ago, cToF, f1, fmtEt, fmtUtc, signed, tideText } from "./format";
import { AT, atLabel } from "./cursor";
import { WIND_UNITS, windFmt, WU } from "./units";
import { nextTide, type StationData, type VarKey } from "./station-data";
import { valueAt } from "./cells";
import { visibleYears } from "./figures";
import { stratNow } from "./readouts";
import { M } from "./models";

/** What the prompt and the tray need from the page. */
export interface PromptHost {
  template: string; // the visitor prompt, with {{placeholders}}
  variable(): string; // the selected water variable, for a method's text ("water temperature", or "the reading")
  isFig(key: string): boolean; // a figure's key, as in a collected plot's id
  layer(): string; // the map's layer ("none" for stations only)
  layerLabel(): string; // its name in the menu
  link(anchor?: string): string; // the page's address as it stands, optionally at an anchor
  credit: string;
  mailTo: string;
}
let H: PromptHost;

/** The prompt's line for the timeline cursor: the observations the table and the pins show at that time. */
function atPromptLine(d: StationData, t: number): string {
  const when = `${fmtUtc(new Date(t * 1000).toISOString())} (${atLabel(t)})`;
  const parts = d.meta.series
    .map((s) => {
      const vals = (["temp", "salinity", "oxygen"] as VarKey[])
        .map((k) => [k, valueAt(d, k, s.depth, t)] as const)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => (k === "temp" ? `${f1(v)} F` : k === "salinity" ? `salinity ${v.toFixed(2)}` : `dissolved oxygen ${v.toFixed(2)} mg/L`));
      return vals.length ? `${s.label.toLowerCase()} ${vals.join(", ")}` : "";
    })
    .filter(Boolean);
  const wind = d.met?.wind?.at(t) ?? NaN;
  const dir = d.met?.dir?.at(t) ?? NaN;
  if (Number.isFinite(wind)) parts.push(`wind ${f1(wind)} kt${Number.isFinite(dir) ? ` from ${compass(dir)}` : ""}`);
  const none = `no observations at that time${t * 1000 > Date.now() ? " (no station forecasts are available)" : ""}`;
  return `  At the page's timeline cursor, ${when}: ${parts.length ? `observed ${parts.join("; ")}` : none}.`;
}

function promptData(stations: StationData[]): string {
  const out: string[] = [];
  for (const d of stations) {
    const st = d.meta;
    const xs = grid(d.now - 96 * DAY, d.now + 14 * DAY, Infinity);
    out.push(`Station ${st.id}, ${st.name} (${st.operator}), ${st.lat.toFixed(2)} N, ${Math.abs(st.lon).toFixed(2)} W.${st.note ? " " + st.note : ""}${!d.live && st.outage_note ? " " + st.outage_note : ""}`);
    if (AT != null) out.push(atPromptLine(d, AT));
    for (const s of st.series) {
      const o = d.obs[s.depth];
      const m = d.temp.m36[s.depth];
      out.push(`  ${s.label} (sensor depth ${s.depth_m.join(" and ")} m; hourly record from ${s.record_start?.slice(0, 10) ?? "unknown"}${s.live ? "" : "; not published on the server now"}):`);
      if (o && o.temperature_c != null) {
        const extra = [
          o.salinity != null ? `salinity ${o.salinity.toFixed(2)}` : "",
          o.oxygen_mg_l != null ? `dissolved oxygen ${o.oxygen_mg_l.toFixed(2)} mg/L (${oxygenStatus(o.oxygen_mg_l)})` : "",
        ].filter(Boolean);
        out.push(`    ${s.live ? "latest" : "last"} observation ${fmtUtc(o.time)} (${ago(o.time)}): ${f1(cToF(o.temperature_c))} F (${o.temperature_c.toFixed(2)} C)${extra.length ? "; " + extra.join("; ") : ""}.`);
      } else out.push(`    no recent observation.`);
      if (!m) continue;
      // Anchor to the latest hour with a 36h mean (the server runs about an hour behind the clock). With no
      // recent data (an outage), anchor the comparison to now: "this time of year in the years we hold".
      const tLast = m.lastValid();
      const recent = xs.indexOf(tLast) >= 0;
      const iAt = recent ? xs.indexOf(tLast) : xs.indexOf(d.now);
      const { shown, hidden } = visibleYears(yearLines(m, xs, d.now));
      if (recent) {
        const cur = m.at(tLast);
        const chg = d.temp.chg[s.depth]?.at(tLast) ?? NaN;
        out.push(`    36h mean as of ${fmtUtc(new Date(tLast * 1000).toISOString())}: ${f1(cur)} F (${f1(fToC(cur))} C); 7-day change: ${signed(chg)} F.`);
      } else {
        out.push(`    no data in the last 96 days (last 36h mean ${fmtUtc(new Date(tLast * 1000).toISOString())}); comparisons below are for this date and hour in earlier years.`);
      }
      const past = shown.filter((l) => l.offset > 0 && Number.isFinite(l.values[iAt])).map((l) => `${l.year} ${f1(l.values[iAt])} F`);
      if (past.length) out.push(`    36h mean at the same date and hour in earlier years: ${past.join("; ")}.`);
      if (hidden.length) out.push(`    years left out of the comparison because under ${COVERAGE_MIN * 100}% of the 110-day window has data: ${hidden.map((l) => l.year).join(", ")}.`);
    }
    if (d.temp.delta) {
      const sb = stratNow(d);
      out.push(`  Surface minus bottom, mean of the last 24 hours with data: ${signed(sb.deltaC, 2)} C, ${sb.status}.`);
    }
    const w = d.met?.last;
    if (w && w.wind_kt != null) {
      const dir = w.dir_deg != null ? `from ${compass(w.dir_deg)} (${Math.round(w.dir_deg)} degrees)` : "direction unknown";
      out.push(
        `  Weather at the ${d.kind === "buoy" ? "buoy" : "station"}, ${fmtUtc(w.time)} (${ago(w.time)}): wind ${f1(w.wind_kt)} kt ${dir}, gusts ${f1(w.gust_kt ?? NaN)} kt` +
          (WU === "kt" ? "; " : ` (wind ${windFmt(w.wind_kt)} ${WIND_UNITS[WU].label}, gusts ${windFmt(w.gust_kt)} ${WIND_UNITS[WU].label}); `) +
          `air ${f1(w.air_f ?? NaN)} F; pressure ${w.pressure_mb != null ? w.pressure_mb.toFixed(1) : "--"} mbar.`,
      );
    }
    if (M.waveSensor(st.id)) out.push(`  ${M.wavesText(st.id)}`);
    if (d.kind === "shore") {
      const e = nextTide(d);
      if (d.levelNow) out.push(`  Water level ${d.levelNow.ft.toFixed(2)} ft above MLLW at ${fmtUtc(d.levelNow.time)} (preliminary).`);
      if (e) out.push(`  Next predicted tide: ${tideText(e)} above MLLW (${fmtUtc(e.t)}).`);
    }
  }
  return out.join("\n");
}

function buildPrompt(meta: Meta, live: Live, stations: StationData[]): string {
  const fill: Record<string, string> = {
    waterway: meta.waterway.name,
    page_url: location.origin + location.pathname,
    generated_at: live.generated_at.slice(0, 16).replace("T", " "),
    strat_mixed: String(STRAT.mixed),
    strat_stratified: String(STRAT.stratified),
    qc: meta.qc,
    data: promptData(stations),
    question: "[Write your question here, for example: how does this fall compare with recent years, and is the water column still stratified?]",
  };
  return H.template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => fill[k] ?? "");
}

/** Plain text of a method entry for the prompt: citations become the references' short labels. */
function methodText(key: string): string {
  const m = METHODS[key];
  if (!m) return "";
  const plain = (t?: string) => (t ?? "").replace(/\[\[([a-z0-9_]+)\]\]/g, (_, k: string) => `(${REF_LABELS[k] ?? k})`).replace(/\{variable\}/g, H.variable()).replace(/\{station\}/g, "the station");
  return [`- ${m.title}${m.shows ? `: ${plain(m.shows)}` : ""}`, m.method ? `  Method: ${plain(m.method)}` : "", m.caveats ? `  Caveats: ${plain(m.caveats)}` : ""].filter(Boolean).join("\n");
}

/** The prompt for the collected items: the data of their stations (all stations when nothing is collected), the
 * methods of the collected plots, the readouts and the map as shown, and the visitor's question. */
function collectPrompt(meta: Meta, live: Live, stations: StationData[], ids: string[], question: string): string {
  const scoped = ids.length ? stations.filter((d) => ids.some((id) => id.startsWith(`${d.meta.id}-`))) : stations;
  let text = buildPrompt(meta, live, scoped.length ? scoped : stations);
  const extra: string[] = [];
  const keys = [...new Set(ids.map((id) => id.split("-").slice(1).join("-")).filter((k) => H.isFig(k)))];
  if (keys.length) extra.push(`Methods for the collected plots:\n${keys.map(methodText).join("\n")}`);
  const rows = ids.filter((id) => id.endsWith("-readouts")).map((id) => {
    const el = document.getElementById(id);
    const station = stations.find((d) => `${d.meta.id}-readouts` === id)?.meta.name ?? id;
    const lines = el ? [...el.querySelectorAll<HTMLElement>(".readout")].map((r) => `  ${r.innerText.replace(/\s*\n\s*/g, "; ")}`) : [];
    return `Readouts at ${station}, as shown (the latest readings${AT != null ? ", not the timeline cursor's time" : ""}; value; label; trend and %ile against the same dates in earlier years; depth and age):\n${lines.join("\n")}`;
  });
  if (rows.length) extra.push(rows.join("\n"));
  if (ids.includes("map")) {
    const key = document.querySelector<HTMLElement>(".field-panel")?.innerText.replace(/\s*\n\s*/g, " ") ?? "";
    const label = document.querySelector<HTMLElement>(".tl-label");
    const when = label?.title || label?.textContent || "now"; // the time in full, with its date
    const pick = H.layer();
    extra.push(`Map as shown: layer ${pick === "none" ? "none (stations only)" : `${pick} (${key})`}, time ${when}.${pick !== "none" ? `\n${methodText(`map-${pick}`)}` : ""}`);
  }
  if (extra.length) text = text.replace("\nQuestion:", `\n${extra.join("\n\n")}\n\nQuestion:`);
  return text.replace(/Question: [\s\S]*$/, `Question: ${question || "[Write your question here]"}`);
}

export function wireCollect(meta: Meta, live: Live, stations: StationData[], host: PromptHost): void {
  H = host;
  mountCollect({
    elementFor: (id) =>
      id === "map"
        ? document.querySelector<HTMLElement>(".map-col")
        : id.endsWith("-readouts")
          ? document.getElementById(id)
          : (document.getElementById(id)?.closest<HTMLElement>("figure") ?? null),
    prompt: (ids, question) => collectPrompt(meta, live, stations, ids, question),
    titleFor: (id, stored) => {
      if (id !== "map") return stored;
      const layer = H.layer() === "none" ? "stations" : H.layerLabel();
      const label = document.querySelector<HTMLElement>(".tl-label");
      const when = label?.title || label?.textContent || "now";
      return `Map: ${layer} \u00b7 ${when}`;
    },
    linkFor: (id) => (id === "map" ? H.link() : id.endsWith("-readouts") ? H.link(id.replace(/-readouts$/, "")) : H.link(id)),
    header: () => `${meta.waterway.name} \u00b7 longhorizon.blue \u00b7 ${fmtEt(new Date().toISOString())} New York time`,
    credit: H.credit,
    mailTo: H.mailTo,
    pageName: meta.waterway.name,
  });
}
