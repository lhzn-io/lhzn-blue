/** The phone's bar: drop-downs that open their panel under the bar (one open at a time; a tap elsewhere or Esc closes
 * them), and the menu (About, Collect, units, theme, locate) with the count of collected items on its button. */
const $ = (id: string) => document.getElementById(id)!;

/** A phone drop-down: the button opens its panel under the bar; a choice, a tap elsewhere or Esc closes it.
 * Opening one closes any other. Returns the setter, for closing after a choice. */
const drops: ((open: boolean) => void)[] = [];
export function dropDown(btn: HTMLElement, panel: HTMLElement): (open: boolean) => void {
  const setOpen = (open: boolean) => {
    if (open) drops.forEach((close) => close !== setOpen && close(false));
    panel.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    // A narrow panel opens under its own button, kept on the screen; a full-width one (the freshness line) as styled.
    if (open && panel.offsetWidth < window.innerWidth * 0.8) {
      const bar = btn.offsetParent as HTMLElement | null;
      const room = (bar?.clientWidth ?? window.innerWidth) - panel.offsetWidth - 8;
      panel.style.left = `${Math.max(8, Math.min(btn.offsetLeft, room))}px`;
      panel.style.right = "auto";
    }
  };
  drops.push(setOpen);
  btn.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (panel.classList.contains("open") && !btn.contains(t) && !panel.contains(t)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) {
      setOpen(false);
      btn.focus();
    }
  });
  return setOpen;
}

/** The phone menu: About (the drawer), Collect (the tray, which shows the "+" marks), units and the theme. While
 * plots are collected the menu button carries their count, so the tray stays one tap away. */
export function wireMore(): void {
  const btn = $("more-menu");
  const setOpen = dropDown(btn, $("more-pop"));
  $("more-pop").addEventListener("click", (e) => {
    const what = (e.target as HTMLElement).closest<HTMLElement>("[data-more]")?.dataset.more;
    if (!what) return;
    setOpen(false);
    if (what === "theme") $("theme-toggle").click();
    else if (what === "collect") window.setTimeout(() => $("collect-open").click());
    else if (what === "locate") return; // its own handler (wireLocate)
    // "About" is a link to /about/; "Forecast verification" a link too.
  });
  const count = $("collect-count");
  const show = () => {
    const n = count.textContent?.trim() ?? "";
    if (n) btn.dataset.count = n;
    else delete btn.dataset.count;
    $("more-pop").querySelector(".more-count")!.textContent = n ? ` (${n})` : "";
  };
  new MutationObserver(show).observe(count, { childList: true, characterData: true, subtree: true });
  show();
}
