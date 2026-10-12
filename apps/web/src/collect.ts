/**
 * Collect: pick plots, readout rows or the map with the "+" beside each (a tick once collected), then from the tray
 * ask your own AI about them (one image plus a prompt scoped to them) or send us a suggestion (the image goes on the
 * clipboard and your mail app opens with the note and a link to each item, ready to paste the image into the body).
 *
 * Nothing is sent to this site: the prompt and the image go to your clipboard, the suggestion goes through your
 * own mail app. No tour: the empty tray says what to do, and the "+" says "Collect this plot".
 */
import { snapshot, type SnapItem } from "./snapshot";

export interface CollectHost {
  /** The element to paint for an item, or null when it is not on screen in this view. */
  elementFor(id: string): HTMLElement | null;
  /** The prompt for the collected items (all of the page when none), ending with the visitor's question. */
  prompt(ids: string[], question: string): string;
  /** The item's title at the moment of the image (the map's names its layer and time); the stored title otherwise. */
  titleFor?(id: string, stored: string): string;
  /** A link that reopens the page on this item. */
  linkFor(id: string): string;
  /** The image's header line and credit footer. */
  header(): string;
  credit: string;
  /** Where suggestions go, and the page's name for the subject. */
  mailTo: string;
  pageName: string;
}

const collected = new Map<string, string>(); // id -> title, in the order collected
let host: CollectHost | null = null;
let tray: HTMLElement | null = null;

const PLUS = "+";
// A drawn tick, not the check-mark character (some platforms render that as an emoji).
const TICK = `<svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

/** Mark every "+" on the page as collected or not (the sections re-render when the view changes). */
function markButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".collect-btn[data-collect]").forEach((b) => {
    const on = collected.has(b.dataset.collect!);
    b.closest("figure, .readouts-row, .map-col")?.classList.toggle("is-collected", on);
    b.innerHTML = on ? TICK : PLUS;
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "Remove from collection" : `Collect this ${b.dataset.kind ?? "plot"}`;
  });
  const count = document.getElementById("collect-count");
  if (count) count.textContent = collected.size ? ` ${collected.size}` : "";
}

function renderTray(): void {
  if (!tray) return;
  const list = tray.querySelector<HTMLElement>(".ct-items")!;
  const empty = !collected.size;
  tray.querySelector<HTMLElement>(".ct-hint")!.hidden = !empty;
  list.innerHTML = [...collected]
    .map(([id, title]) => `<li><span>${title}</span><button type="button" class="ct-remove" data-remove="${id}" aria-label="Remove ${title}">&times;</button></li>`)
    .join("");
  tray.querySelector<HTMLElement>(".ct-count")!.textContent = empty ? "" : `${collected.size} collected`;
  tray.querySelectorAll<HTMLButtonElement>("[data-needs-items]").forEach((b) => (b.disabled = empty));
  markButtons();
}

function openTray(): void {
  if (!tray) return;
  tray.hidden = false;
  document.getElementById("collect-open")?.setAttribute("aria-expanded", "true");
  document.body.classList.add("collecting");
  renderTray();
}

function closeTray(): void {
  if (!tray) return;
  tray.hidden = true;
  tray.querySelectorAll<HTMLElement>(".ct-panel").forEach((p) => (p.hidden = true));
  document.getElementById("collect-open")?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("collecting");
}

function toggle(id: string, title: string): void {
  if (collected.has(id)) collected.delete(id);
  else collected.set(id, title);
  openTray();
}

/** The image of the collected items that are on screen in this view. */
function makeImage(): Promise<Blob> {
  const items: SnapItem[] = [...collected]
    .map(([id, title]) => ({ title: host!.titleFor?.(id, title) ?? title, el: host!.elementFor(id) }))
    .filter((it): it is SnapItem => !!it.el);
  return snapshot(items, host!.header(), host!.credit);
}

/** Put the image on the clipboard; the ClipboardItem is made inside the click (Safari requires it). */
async function copyImage(): Promise<void> {
  const blob = makeImage();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

async function download(): Promise<void> {
  const blob = await makeImage();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `longhorizon-blue-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function status(panel: string, text: string): void {
  const el = tray?.querySelector<HTMLElement>(`[data-panel="${panel}"] .ct-status`);
  if (el) el.textContent = text;
}

function buildTray(): HTMLElement {
  const el = document.createElement("div");
  el.className = "collect-tray";
  el.id = "collect-tray";
  el.hidden = true;
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Collected plots");
  el.innerHTML = `
    <div class="ct-head"><b>Collect</b><span class="ct-count"></span>
      <button type="button" class="tab ct-done">Done</button></div>
    <p class="ct-hint">Collected plots gather here. Then ask your AI about them, or send us a suggestion. Esc to close.</p>
    <ul class="ct-items"></ul>
    <div class="ct-actions">
      <button type="button" class="button" data-open="ask">Ask your AI</button>
      <button type="button" class="button" data-open="suggest">Send us a suggestion</button>
      <button type="button" class="tab" data-act="clear" data-needs-items>Clear</button>
    </div>
    <div class="ct-panel" data-panel="ask" hidden>
      <label class="ct-label" for="ct-question">Your question</label>
      <textarea id="ct-question" rows="2">How do these compare with recent years, and what stands out?</textarea>
      <div class="ct-buttons">
        <button type="button" class="button" data-act="copy-image" data-needs-items>Copy image</button>
        <button type="button" class="button" data-act="copy-prompt">Copy prompt</button>
        <button type="button" class="tab" data-act="download" data-needs-items>Download image</button>
      </div>
      <p class="ct-note">Paste the image and the prompt into the assistant you already use. With nothing collected, the prompt covers the whole page. The answer comes from your assistant, not from us (<a href="/terms/#ai">how this site uses AI</a>).</p>
      <p class="ct-status" aria-live="polite"></p>
    </div>
    <div class="ct-panel" data-panel="suggest" hidden>
      <label class="ct-label" for="ct-note">A correction, an idea, local knowledge</label>
      <textarea id="ct-note" rows="3"></textarea>
      <div class="ct-buttons"><button type="button" class="button" data-act="mail">Copy image and open email</button></div>
      <p class="ct-note">Your mail app opens with your note and a link to each collected item; the image is on your clipboard, so paste it into the body. Nothing is sent to this site.</p>
      <p class="ct-status" aria-live="polite"></p>
    </div>`;
  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const remove = t.closest<HTMLElement>("[data-remove]");
    if (remove) {
      collected.delete(remove.dataset.remove!);
      renderTray();
      return;
    }
    if (t.closest(".ct-done")) return closeTray();
    const open = t.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (open) {
      el.querySelectorAll<HTMLElement>(".ct-panel").forEach((p) => (p.hidden = p.dataset.panel !== open));
      el.querySelector<HTMLTextAreaElement>(open === "ask" ? "#ct-question" : "#ct-note")?.focus();
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act || !host) return;
    try {
      if (act === "clear") {
        collected.clear();
        renderTray();
      } else if (act === "copy-image") {
        status("ask", "Making the image...");
        await copyImage();
        status("ask", "Image copied. Paste it into your assistant, then copy the prompt.");
      } else if (act === "copy-prompt") {
        const q = el.querySelector<HTMLTextAreaElement>("#ct-question")!.value.trim();
        const text = host.prompt([...collected.keys()], q);
        await navigator.clipboard.writeText(text);
        status("ask", `Prompt copied (${text.length.toLocaleString()} characters). Paste it after the image.`);
      } else if (act === "download") {
        await download();
        status("ask", "Image downloaded.");
      } else if (act === "mail") {
        const note = el.querySelector<HTMLTextAreaElement>("#ct-note")!.value.trim();
        if (collected.size) {
          status("suggest", "Making the image...");
          await copyImage();
        }
        const links = [...collected].map(([id, title]) => `- ${title}: ${host!.linkFor(id)}`).join("\n");
        const body = [note, links ? `About:\n${links}` : "", collected.size ? "[The image is on your clipboard: paste it here.]" : ""].filter(Boolean).join("\n\n");
        window.location.href = `mailto:${host.mailTo}?subject=${encodeURIComponent(`Suggestion: ${host.pageName}`)}&body=${encodeURIComponent(body)}`;
        status("suggest", collected.size ? "Your mail app should open; paste the image into the body." : "Your mail app should open.");
      }
    } catch (err) {
      console.error(err);
      const panel = act === "mail" ? "suggest" : "ask";
      status(panel, act === "copy-prompt" ? "The clipboard was blocked; try again, or allow clipboard access." : "The image could not be copied here; use Download image.");
    }
  });
  return el;
}

export function mountCollect(h: CollectHost): void {
  host = h;
  tray = buildTray();
  document.body.appendChild(tray);
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".collect-btn[data-collect]");
    if (b) {
      e.stopPropagation();
      toggle(b.dataset.collect!, b.dataset.title ?? b.dataset.collect!);
      return;
    }
    if ((e.target as HTMLElement).closest("#collect-open")) {
      if (tray!.hidden) openTray();
      else closeTray();
    }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tray && !tray.hidden && !document.querySelector("dialog[open]")) closeTray();
  });
  // Sections re-render when the view changes: keep their "+" in step with the collection.
  const watch = ["stations", "map-foot"].map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  let pending = 0;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      markButtons();
    }, 30);
  });
  watch.forEach((w) => obs.observe(w, { childList: true, subtree: true }));
  markButtons();
}
