/**
 * Hover hints in the site's own colours and type, in place of the browser's tooltips. Any element with a title
 * (or an SVG with a <title>) shows it after a short pause under the pointer, or at once on keyboard focus. The
 * title moves to data-hint on first use, so the browser's own tooltip never appears; a title set again later
 * (some labels change with the data) is picked up the next time. Touch shows nothing: a tap acts.
 */
export function wireHints(): void {
  const tip = document.createElement("div");
  tip.className = "hint";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  let owner: Element | null = null;
  let timer = 0;

  const textOf = (el: Element): string => {
    const title = el.getAttribute("title");
    if (title) {
      el.setAttribute("data-hint", title);
      el.setAttribute("aria-description", title); // screen readers keep what the title said
      el.removeAttribute("title");
      return title;
    }
    const svgTitle = el instanceof SVGSVGElement ? el.querySelector(":scope > title") : null;
    if (svgTitle?.textContent) {
      el.setAttribute("data-hint", svgTitle.textContent);
      svgTitle.remove(); // its text stays in the svg's aria-label
    }
    return el.getAttribute("data-hint") ?? "";
  };

  const show = (el: Element) => {
    const text = textOf(el);
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const below = r.bottom + 8 + h <= window.innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`;
  };
  const hide = () => {
    window.clearTimeout(timer);
    owner = null;
    tip.hidden = true;
  };
  const target = (e: Event) => (e.target as Element | null)?.closest?.("[title], [data-hint], svg:has(> title)") ?? null;

  document.addEventListener("pointerover", (e) => {
    if ((e as PointerEvent).pointerType === "touch") return;
    const el = target(e);
    if (el === owner) return; // moving between the parts of one element
    hide();
    if (el) {
      owner = el;
      textOf(el); // take the title now, before the browser's own tooltip can show it
      timer = window.setTimeout(() => owner === el && show(el), 350);
    }
  });
  document.addEventListener("pointerout", (e) => {
    const to = (e as PointerEvent).relatedTarget as Element | null;
    if (owner && to && owner.contains(to)) return;
    hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = target(e);
    hide();
    // Keyboard focus only: a click focuses a button too, and its hint would cover what the click opened.
    if (el && (e.target as Element).matches?.(":focus-visible")) {
      owner = el;
      show(el);
    }
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide);
  // A scroll hides a hint on screen; one still waiting to show is placed when it shows, so it is left alone
  // (the page also scrolls itself as sections load).
  window.addEventListener("scroll", () => !tip.hidden && hide(), { passive: true });
}
