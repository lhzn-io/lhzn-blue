/** The Rivers view: the gauges table (flow, its class for the date, river turbidity), the gauges' pins, the watershed
 * shown when a row is pointed at, and the readouts at the top of each river section. */
import type { Pin } from "../map";
import type { LastObs } from "../series";
import { ago } from "./format";
import { AT, atFuture, atLabel, sparklineOf } from "./cursor";
import { obsState, type StationData } from "./station-data";
import { cfs, pct, percentileOf, pctText, riverClass, riverFlow } from "./rivers";
import { M } from "./models";

/** The Rivers view's overview: each gauge's flow, where it sits for the date, and river turbidity. */
export function riverTable(d: StationData | undefined): string {
  if (!d?.river) return `<p class="note">River data could not load.</p>`;
  const r = d.river;
  let total = 0;
  let medians = 0;
  let complete = true;
  const rows = r.gauges.map((g) => {
    const flowAt = AT != null ? riverFlow(r, g.id, AT) : NaN;
    const o =
      AT == null
        ? r.last[g.id]
        : Number.isFinite(flowAt)
          ? { time: new Date(AT * 1000).toISOString(), flow_cfs: flowAt, turb_fnu: g.turbidity ? (Number.isFinite(r.turb?.at(AT) ?? NaN) ? r.turb!.at(AT) : null) : null }
          : null;
    if (!o || o.flow_cfs == null) {
      if (!g.discontinued) complete = false; // a discontinued gauge is left out of the total, and the total says so
      const why = g.discontinued && (AT == null || AT * 1000 > Date.parse(g.discontinued))
        ? `discontinued ${new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(g.discontinued))}`
        : AT != null ? (atFuture() ? "no forecast" : "no reading") : "no recent reading";
      return `<tr data-gauge="${g.id}"><th scope="row"><a href="#${g.id}"><i class="dot offline"></i>${g.river}</a></th><td class="offline" title="${g.status_note ?? ""}"><b>--</b><small>${why}</small></td><td class="na">&middot;</td><td class="na"><small>${g.turbidity ? "--" : "no sensor"}</small></td></tr>`;
    }
    const t = Date.parse(o.time) / 1000;
    const state = AT != null ? "asof" : obsState({ time: o.time } as LastObs);
    const cls = riverClass(r, g.id, t, o.flow_cfs);
    const med = pct(r, g.id, "p50", t);
    total += o.flow_cfs;
    medians += Number.isFinite(med) ? med : NaN;
    const spark = r.flow[g.id] ? sparklineOf(r.flow[g.id]!, M.palette().depth.SFC, "cfs", 0) : "";
    const turb = !g.turbidity
      ? `<td class="na" title="This gauge has no turbidity sensor"><small>no sensor</small></td>`
      : o.turb_fnu != null
        ? `<td title="River turbidity at ${g.name.split(/ (?:at|near) /).pop()}, ${ago(o.time)}"><b>${o.turb_fnu.toFixed(1)}<small class="g"> FNU</small></b></td>`
        : `<td class="offline"><b>--</b><small>no recent reading</small></td>`;
    return `<tr data-gauge="${g.id}"><th scope="row" title="${g.name} (USGS ${g.usgs_id})"><a href="#${g.id}"><i class="dot ${state}"></i>${g.river}</a></th>
      <td class="${state}" title="${cfs(o.flow_cfs)} cfs, ${ago(o.time)}">${spark}<b>${cfs(o.flow_cfs)}<small class="g"> cfs</small></b><small>${AT != null ? "observed" : ago(o.time).replace(" ago", "")}</small></td>
      <td class="river-class ${cls.replace(/ /g, "-")}" title="Median for the date ${cfs(med)} cfs"><b>${cls || "--"}</b><small>median ${cfs(med)}</small></td>${turb}</tr>`;
  });
  const off = r.gauges.filter((g) => g.discontinued).length;
  const share =
    (complete && Number.isFinite(medians) && medians > 0 ? `${Math.round((100 * total) / medians)}% of the summed medians for the date` : "") +
    (off ? `; the ${off === 1 ? "discontinued gauge is" : `${off} discontinued gauges are`} left out` : "");
  return `<table class="status-grid" id="status-panel">
    <caption>${AT != null ? `River flow at ${atLabel(AT)}` : "Latest river flow"}, largest basin first: cubic feet per second, against normal for the date</caption>
    <thead><tr><th></th><th scope="col">Flow</th><th scope="col">For the date</th><th scope="col">Turbidity</th></tr></thead>
    <tbody>${rows.join("")}<tr class="total"><th scope="row">All ${r.gauges.length - off}</th><td>${complete ? `<b>${cfs(total)}<small class="g"> cfs</small></b>` : "--"}</td><td colspan="2"><small>${share}</small></td></tr></tbody>
  </table>
  <p class="status-key">USGS classes: normal is the 25th to 75th percentile of daily flow for the date; much below and much above are under the 10th and over the 90th. Values are provisional. Point at a river to see its watershed on the map.</p>`;
}

/** The gauges' map pins in the Rivers view: flow and its class, at the page's time. */
export function gaugePins(sections: StationData[]): Pin[] {
  return sections.filter((d) => d.kind === "river").map((d) => {
    const g = d.gauge!;
    if (AT != null) {
      const f = riverFlow(d.river!, g.id, AT);
      const label = Number.isFinite(f) ? `${cfs(f)} cfs, ${riverClass(d.river!, g.id, AT, f)}; observed ${atLabel(AT)}` : `no ${atFuture() ? "forecast" : "reading"} at ${atLabel(AT)}`;
      const last = d.river!.last[g.id];
      const base = last ? obsState({ time: last.time } as LastObs) : "offline";
      return { id: g.id, name: g.name, lat: g.lat, lon: g.lon, state: Number.isFinite(f) ? base : "offline", label };
    }
    const o = d.river!.last[g.id];
    const t = o ? Date.parse(o.time) / 1000 : NaN;
    const label = o?.flow_cfs != null ? `${cfs(o.flow_cfs)} cfs, ${riverClass(d.river!, g.id, t, o.flow_cfs)}; ${ago(o.time)}` : g.discontinued ? "gauge discontinued" : "no recent reading";
    return { id: g.id, name: g.name, lat: g.lat, lon: g.lon, state: o ? obsState({ time: o.time } as LastObs) : "offline", label };
  });
}

/** Pointing at a river's row in the table shows its watershed on the map. */
export function wireRiverHover(): void {
  const box = document.getElementById("status")!;
  let pending = 0;
  let current: string | null = null;
  const focus = (id: string | null) => {
    if (id === current) return;
    current = id;
    window.clearTimeout(pending);
    pending = window.setTimeout(async () => {
      try {
        (await import("../map")).focusBasin(id);
      } catch {
        /* map not loaded */
      }
    }, 120);
  };
  const row = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>("tr[data-gauge]")?.dataset.gauge ?? null;
  box.addEventListener("pointerover", (e) => M.view() === "rivers" && row(e) && focus(row(e)));
  box.addEventListener("focusin", (e) => M.view() === "rivers" && row(e) && focus(row(e)));
  box.addEventListener("pointerleave", () => M.view() === "rivers" && focus(null));
}

/** A river section's readouts (a gauge, or the all-rivers summary led by the largest basin); null for any other station. */
export function riverReadoutsHtml(d: StationData): string | null {
  if (d.kind === "river") {
    const r = d.river!;
    const g = d.gauge!;
    const o = r.last[g.id];
    const t = o ? Date.parse(o.time) / 1000 : NaN;
    const items = [
      o?.flow_cfs != null
        ? `<div class="readout"><div class="num">${cfs(o.flow_cfs)}<small>cfs</small></div><span class="lab">Flow</span><span class="sub ${obsState({ time: o.time } as LastObs)}">${ago(o.time)}</span></div>`
        : `<div class="readout"><div class="num">--</div><span class="lab">Flow</span><span class="sub offline">no recent reading</span></div>`,
      o?.flow_cfs != null
        ? `<div class="readout"><div class="num">${pctText(percentileOf(r, g.id, t, o.flow_cfs))}</div><span class="lab">Percentile for the date</span><span class="sub">${riverClass(r, g.id, t, o.flow_cfs)} &middot; median ${cfs(pct(r, g.id, "p50", t))} cfs</span></div>`
        : "",
      g.turbidity && o?.turb_fnu != null
        ? `<div class="readout"><div class="num">${o.turb_fnu.toFixed(1)}<small>FNU</small></div><span class="lab">Turbidity</span><span class="sub">${ago(o.time)}</span></div>`
        : "",
    ];
    return items.join("");
  }
  if (d.kind === "rivers") {
    const r = d.river!;
    const main = r.gauges[0]; // the largest basin
    const conn = r.last[main.id];
    const t = conn ? Date.parse(conn.time) / 1000 : NaN;
    const total = r.gauges.filter((g) => !g.discontinued).reduce((a, g) => a + (r.last[g.id]?.flow_cfs ?? NaN), 0);
    return [
      `<div class="readout"><div class="num">${cfs(total)}<small>cfs</small></div><span class="lab">All ${r.gauges.filter((g) => !g.discontinued).length} live gauges</span><span class="sub">the sum of the latest readings</span></div>`,
      conn?.flow_cfs != null
        ? `<div class="readout"><div class="num">${cfs(conn.flow_cfs)}<small>cfs</small></div><span class="lab">${main.river} River</span><span class="sub">${riverClass(r, main.id, t, conn.flow_cfs)} for the date &middot; ${ago(conn.time)}</span></div>`
        : "",
      conn?.turb_fnu != null
        ? `<div class="readout"><div class="num">${conn.turb_fnu.toFixed(1)}<small>FNU</small></div><span class="lab">${main.river} turbidity</span><span class="sub">at ${main.name.split(/ (?:at|near) /).pop()} &middot; ${ago(conn.time)}</span></div>`
        : "",
    ].join("");
  }
  return null;
}
