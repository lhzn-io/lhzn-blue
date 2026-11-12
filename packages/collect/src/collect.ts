/**
 * Collect: pick plots (or any other items) with the "+" beside each (a tick once collected), then from the tray ask
 * your own AI about them (one image plus a prompt scoped to them) or, when the page takes suggestions, send one (the
 * image goes on the clipboard and the visitor's mail app opens with the note and a link to each item, ready to paste
 * the image into the body).
 *
 * Nothing is sent to the site: the prompt and the image go to the clipboard, the suggestion goes through the
 * visitor's own mail app. No tour: the empty tray says what to do, and the "+" says "Collect this plot".
 *
 * The page supplies the "+" buttons (`<button class="collect-btn" data-collect="id" data-title="..." data-kind="plot">`)
 * and, optionally, a button with id `collect-open` that opens the tray (with a `collect-count` element inside it);
 * `mountCollect` adds the tray and handles the rest.
 */
import { snapshot, type SnapItem } from "./snapshot.js";

export interface CollectHost {
  /** The element to paint for an item, or null when it is not on screen in this view. */
  elementFor(id: string): HTMLElement | null;
  /** The prompt for the collected items (all of the page when none), ending with the visitor's question. */
  prompt(ids: string[], question: string): string;
  /** The item's title at the moment of the image (a map's might name its layer and time); the stored title otherwise. */
  titleFor?(id: string, stored: string): string;
  /** A link that reopens the page on this item. */
  linkFor(id: string): string;
  /** The image's header line and credit footer. */
  header(): string;
  credit: string;
  /** Where suggestions go, and the page's name for the subject. Without `mailTo` there is no suggestion panel. */
  mailTo?: string;
  pageName?: string;
}

/** The tray's words. Each has a default; a page overrides the ones it needs. Notes may hold HTML. */
export interface CollectLabels {
  region: string; // the tray's accessible name
  title: string;
  hint: string; // shown while the tray is empty
  ask: string;
  suggest: string;
  clear: string;
  done: string;
  questionLabel: string;
  question: string; // the question's starting text
  copyImage: string;
  copyPrompt: string;
  download: string;
  askNote: string; // HTML; the terms link, when given, is added at its end
  suggestLabel: string;
  mail: string;
  suggestNote: string; // HTML
  suggestExtra: string; // HTML, a further note under the suggestion panel (e.g. where to post in public)
}

export interface CollectOptions {
  labels?: Partial<CollectLabels>;
  /** A link from the ask panel's note to the page that says how the site uses AI. None when absent. */
  terms?: { href: string; text: string };
  /** Show "Send us a suggestion" and its panel. By default, when the host has `mailTo`. */
  suggest?: boolean;
  /** The element marked `is-collected` around each "+" (default `figure`). */
  itemSelector?: string;
  /** Ids of the elements whose contents re-render (their "+" are kept in step); the whole body by default. */
  watch?: string[];
  /** The downloaded image's file name, before the date (default `collect`). */
  fileName?: string;
  /** Selectors of further elements left out of the image (controls, hover overlays). */
  skip?: string;
  /** Class names of the tray's main and quiet buttons, to match the page's own (default `button` and `tab`). */
  buttonClass?: string;
  quietClass?: string;
}

export const DEFAULT_LABELS: CollectLabels = {
  region: "Collected plots",
  title: "Collect",
  hint: "Collected plots gather here. Then ask your AI about them, or send us a suggestion. Esc to close.",
  ask: "Ask your AI",
  suggest: "Send us a suggestion",
  clear: "Clear",
  done: "Done",
  questionLabel: "Your question",
  question: "How do these compare with recent years, and what stands out?",
  copyImage: "Copy image",
  copyPrompt: "Copy prompt",
  download: "Download image",
  askNote:
    "Paste the image and the prompt into the assistant you already use. With nothing collected, the prompt covers the whole page. The answer comes from your assistant, not from us.",
  suggestLabel: "A correction, an idea, local knowledge",
  mail: "Copy image and open email",
  suggestNote:
    "Your mail app opens with your note and a link to each collected item; the image is on your clipboard, so paste it into the body. Nothing is sent to this site.",
  suggestExtra: "",
};

const collected = new Map<string, string>(); // id -> title, in the order collected
let host: CollectHost | null = null;
let opts: CollectOptions = {};
let tray: HTMLElement | null = null;

const PLUS = "+";
// A drawn tick, not the check-mark character (some platforms render that as an emoji).
const TICK = `<svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Mark every "+" on the page as collected or not (the sections re-render when the view changes). */
function markButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".collect-btn[data-collect]").forEach((b) => {
    const on = collected.has(b.dataset.collect!);
    b.closest(opts.itemSelector ?? "figure")?.classList.toggle("is-collected", on);
    // Only a change of state touches the button's contents, so the watcher below does not wake itself.
    if (!!b.querySelector("svg") !== on || (!on && b.textContent !== PLUS)) b.innerHTML = on ? TICK : PLUS;
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
    .map(([id, title]) => `<li><span>${esc(title)}</span><button type="button" class="ct-remove" data-remove="${esc(id)}" aria-label="Remove ${esc(title)}">&times;</button></li>`)
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
  return snapshot(items, host!.header(), host!.credit, opts.skip);
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
  a.download = `${opts.fileName ?? "collect"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function status(panel: string, text: string): void {
  const el = tray?.querySelector<HTMLElement>(`[data-panel="${panel}"] .ct-status`);
  if (el) el.textContent = text;
}

/** The ask panel's note, with the terms link in brackets before its final full stop. */
function askNote(L: CollectLabels): string {
  if (!opts.terms) return L.askNote;
  const link = `(<a href="${esc(opts.terms.href)}">${opts.terms.text}</a>)`;
  return /\.\s*$/.test(L.askNote) ? L.askNote.replace(/\.\s*$/, ` ${link}.`) : `${L.askNote} ${link}`;
}

function buildTray(): HTMLElement {
  const L: CollectLabels = { ...DEFAULT_LABELS, ...opts.labels };
  const btn = opts.buttonClass ?? "button";
  const quiet = opts.quietClass ?? "tab";
  const suggest = opts.suggest ?? !!host?.mailTo;
  const el = document.createElement("div");
  el.className = "collect-tray";
  el.id = "collect-tray";
  el.hidden = true;
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", L.region);
  el.innerHTML = `
    <div class="ct-head"><b>${L.title}</b><span class="ct-count"></span>
      <button type="button" class="${quiet} ct-quiet ct-done">${L.done}</button></div>
    <p class="ct-hint">${L.hint}</p>
    <ul class="ct-items"></ul>
    <div class="ct-actions">
      <button type="button" class="${btn} ct-main" data-open="ask">${L.ask}</button>
      ${suggest ? `<button type="button" class="${btn} ct-main" data-open="suggest">${L.suggest}</button>` : ""}
      <button type="button" class="${quiet} ct-quiet" data-act="clear" data-needs-items>${L.clear}</button>
    </div>
    <div class="ct-panel" data-panel="ask" hidden>
      <label class="ct-label" for="ct-question">${L.questionLabel}</label>
      <textarea id="ct-question" rows="2">${esc(L.question)}</textarea>
      <div class="ct-buttons">
        <button type="button" class="${btn} ct-main" data-act="copy-image" data-needs-items>${L.copyImage}</button>
        <button type="button" class="${btn} ct-main" data-act="copy-prompt">${L.copyPrompt}</button>
        <button type="button" class="${quiet} ct-quiet" data-act="download" data-needs-items>${L.download}</button>
      </div>
      <p class="ct-note">${askNote(L)}</p>
      <p class="ct-status" aria-live="polite"></p>
    </div>${
      suggest
        ? `
    <div class="ct-panel" data-panel="suggest" hidden>
      <label class="ct-label" for="ct-note">${L.suggestLabel}</label>
      <textarea id="ct-note" rows="3"></textarea>
      <div class="ct-buttons"><button type="button" class="${btn} ct-main" data-act="mail">${L.mail}</button></div>
      <p class="ct-note">${L.suggestNote}</p>${L.suggestExtra ? `
      <p class="ct-note">${L.suggestExtra}</p>` : ""}
      <p class="ct-status" aria-live="polite"></p>
    </div>`
        : ""
    }`;
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
      } else if (act === "mail" && host.mailTo) {
        const note = el.querySelector<HTMLTextAreaElement>("#ct-note")!.value.trim();
        if (collected.size) {
          status("suggest", "Making the image...");
          await copyImage();
        }
        const links = [...collected].map(([id, title]) => `- ${title}: ${host!.linkFor(id)}`).join("\n");
        const body = [note, links ? `About:\n${links}` : "", collected.size ? "[The image is on your clipboard: paste it here.]" : ""].filter(Boolean).join("\n\n");
        const subject = host.pageName ? `Suggestion: ${host.pageName}` : "Suggestion";
        window.location.href = `mailto:${host.mailTo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

/** Add the tray to the page and listen for the "+" buttons and the `collect-open` button. Once per page. */
export function mountCollect(h: CollectHost, options: CollectOptions = {}): void {
  host = h;
  opts = options;
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
  const watch = options.watch
    ? options.watch.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x)
    : [document.body];
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

/** The ids collected so far, in order. */
export const collectedIds = (): string[] => [...collected.keys()];
