/** In-page links shared by the waterway pages: every jump to a station or plot is a history entry (Back returns) and
 * leaves an address that can be shared as it stands, and each plot has a chain button that copies its address.
 *
 * A page supplies its own address builder (its view, layer and time, plus the anchor) to `wireLinks`.
 */

export const CHAIN_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6.6 9.4l2.8-2.8M7.3 4.4l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L11 8.1M9 11.6l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

/** The chain button for an anchor on the page (a plot, a station). */
export const chainButton = (anchor: string, label: string) =>
  `<button class="fig-link" type="button" data-link="${anchor}" aria-label="Copy a link to ${label}">${CHAIN_ICON}</button>`;

/** Scroll to the address's anchor (a plot's figure, else the element), its top just under the page bar, and outline
 * it for a moment. */
export function revealLinked(smooth = false): void {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  const target = el.closest("figure") ?? el;
  target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  target.classList.add("linked");
  window.setTimeout(() => target.classList.remove("linked"), 2600);
}

let addressFor: (anchor?: string) => string = (a) => `${location.pathname}${location.search}${a ? `#${a}` : ""}`;

/** Go to an anchor on the page: a history entry, then the scroll. */
export function navigateTo(id: string): void {
  if (!document.getElementById(id)) return;
  if (decodeURIComponent(location.hash.slice(1)) !== id) history.pushState(null, "", addressFor(id));
  revealLinked(true);
}

/** Page-wide: in-page #links (and, where `rowAnchor` gives one, a click anywhere on a table row) go through
 * navigateTo; a chain button copies its anchor's address. */
export function wireLinks(address: (anchor?: string) => string, rowAnchor?: (e: MouseEvent) => string | null): void {
  addressFor = address;
  document.addEventListener("click", async (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target as HTMLElement;
    const copy = el.closest<HTMLButtonElement>(".fig-link");
    if (copy?.dataset.link) {
      const url = new URL(address(copy.dataset.link), location.href).href;
      try {
        await navigator.clipboard.writeText(url);
        copy.dataset.copied = "1";
        window.setTimeout(() => delete copy.dataset.copied, 1600);
      } catch {
        window.prompt("Copy this link:", url); // clipboard refused: show it to copy by hand
      }
      return;
    }
    const a = el.closest<HTMLAnchorElement>('a[href^="#"]');
    const id = a ? decodeURIComponent(a.getAttribute("href")!.slice(1)) : !el.closest("button, a, input, select, label") ? rowAnchor?.(e) ?? "" : "";
    if (!id || !document.getElementById(id)) return;
    e.preventDefault();
    navigateTo(id);
  });
}
