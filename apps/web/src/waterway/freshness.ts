/** How fresh the page's data is, and the outage note when the buoys' server cannot be reached. */
import type { Live, Meta } from "../series";
import { fmtEt, span } from "./format";
import { dropDown } from "./phone-bar";

const $ = (id: string) => document.getElementById(id)!;

/** The masthead's "Updated" strip (the fetch's age and the buoys' lag), and, while the buoys' data server is
 * unreachable, the outage note: in the masthead, and on a phone behind an icon. The operator's own words about the
 * outage, and what the readings since then are, come from the page. */
export function updatedStrip(meta: Meta, live: Live, notes: { operator: string; transcribed: string }): void {
  const latest = Object.values(live.series)
    .map((s) => s.last_obs?.time)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const failing = Object.entries(live.datasets)
    // Only datasets that were working before: a series in a known outage is explained in its own section.
    .filter(([, s]) => s.last_error && s.last_ok && s.last_error.slice(0, 20) > s.last_ok)
    .map(([k]) => k);
  // The server itself down (the jobs could not connect at all): one plain note instead of a list of datasets, dated
  // from the last fetch that worked. Only while the newest attempt failed, and only after 12 hours without a good fetch,
  // so a passing hiccup does not raise the notice (a shorter gap shows in the strip as a failed fetch).
  const lastOk = Object.values(live.datasets)
    .map((s) => s.last_ok)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const unreachable = Object.values(live.datasets).some((s) => s.last_error?.includes("ServerUnreachable") && (!s.last_ok || s.last_error.slice(0, 20) > s.last_ok));
  const down = unreachable && (!lastOk || Date.parse(live.generated_at) - Date.parse(lastOk) > 12 * 3600e3);
  const outage = $("outage");
  const since = (t: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(t));
  // While the server is down, the newest readings may be transcribed from the operator's panel images.
  const transcribed = Object.values(live.series ?? {}).some((s) => s.last_obs?.source === "panel") ||
    Object.values(live.met ?? {}).some((m) => m.last_obs?.source === "panel");
  if (down) {
    outage.textContent = `Buoy data unavailable from the server since ${lastOk ? since(lastOk) : "the last update"}.${transcribed ? ` ${notes.transcribed}` : ""} ${notes.operator}`;
    // On phones the note is an icon in the masthead that opens it (styled in site.css).
    $("outage-dialog-text").textContent = outage.textContent;
    $("outage-pop").textContent = outage.textContent;
    $("outage-icon").hidden = false;
    outage.hidden = false;
  }
  const draw = () => {
    // How stale the buoys were when the data was fetched, as a delta, rather than a second timestamp.
    const fetched = Date.parse(live.generated_at);
    const parts = [
      `<b>Updated</b>${fmtEt(live.generated_at)} <span class="ago">(${span(fetched, Date.now())} ago)</span>`,
      latest ? `buoys ${span(Date.parse(latest), fetched)} behind` : "no recent buoy reading",
    ];
    if (down) parts.push(`<span class="warn">buoy data unavailable since ${lastOk ? since(lastOk) : "the last update"}</span>`);
    else if (failing.length) parts.push(`<span class="warn">fetch failed: ${failing.join(", ")}</span>`);
    $("updated").innerHTML = parts.join(`<span class="sep">&middot;</span>`);
    // The bar: a dot and the age; the buoys' lag only past its usual hour or two; the exact times in the hint.
    const fresh = $("fresh");
    const age = Date.now() - fetched;
    const lag = latest ? fetched - Date.parse(latest) : Infinity;
    const lagging = lag > 2 * 3600_000;
    const state = age > 24 * 3600_000 ? "offline" : failing.length || lagging || age > 3 * 3600_000 ? "delayed" : "live";
    const note = down ? "buoys unavailable" : failing.length ? "fetch failed" : !latest ? "no recent buoy reading" : lagging ? `buoys ${span(Date.parse(latest), fetched)} behind` : "";
    fresh.innerHTML = `<i class="dot ${state}"></i>${span(fetched, Date.now())}<span class="fresh-long">&nbsp;ago</span>${note ? `<span class="lag">${note}</span>` : ""}`;
    fresh.title =
      `Fetched ${fmtEt(live.generated_at)}` + (latest ? ` · latest buoy reading ${fmtEt(latest)}` : "") + ` · history rebuilt ${fmtEt(meta.generated_at)} (New York time)`;
    fresh.setAttribute("aria-label", `Data fetched ${span(fetched, Date.now())} ago${note ? `, ${note}` : ""}`);
    $("updated").title =
      `Fetched ${fmtEt(live.generated_at)}` +
      (latest ? `; latest buoy reading ${fmtEt(latest)}` : "") +
      `; history rebuilt ${fmtEt(meta.generated_at)} (New York time)` +
      (down ? "; buoy data unavailable" : failing.length ? `; the last fetch failed for ${failing.join(", ")}, so those show the last good values` : "") +
      ".";
  };
  draw();
  window.setInterval(draw, 60_000);
  dropDown($("fresh"), $("updated"));
}

/** The phone's outage icon: opens the note in a dialog. */
export function wireOutageIcon(): void {
  const dialog = $("outage-dialog") as HTMLDialogElement;
  // With a mouse the note shows on hover or focus (site.css); a tap on a touch screen opens it in the dialog.
  $("outage-icon").addEventListener("click", () => {
    if (!matchMedia("(hover: hover)").matches) dialog.showModal();
  });
  $("outage-dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
}
