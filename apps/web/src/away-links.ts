/**
 * Links to other sites open in a new tab, so a visitor keeps their place (the map's view, the hour, a collected plot).
 * One capture-phase listener sets the target as a link is followed, which covers the links written into the page
 * later (readouts, method notes, references) as well as the static ones. A link that names its own target keeps it.
 */
const SITE = /(^|\.)longhorizon\.blue$/;

document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[href]");
    if (!a || a.target || (a.protocol !== "https:" && a.protocol !== "http:")) return;
    if (a.hostname === location.hostname || SITE.test(a.hostname)) return;
    a.target = "_blank";
    if (!/\bnoopener\b/.test(a.rel)) a.rel = `${a.rel} noopener`.trim();
  },
  true,
);
