/** Suggestions drawer: a short note goes to the waterway's address through the visitor's own mail app.
 * Nothing is posted to this site, so there is no form endpoint to spam and no message stored here. */
export function wireSuggest(): void {
  const drawer = document.getElementById("suggest") as HTMLDetailsElement | null;
  const form = document.getElementById("suggest-form") as HTMLFormElement | null;
  const text = document.getElementById("suggest-text") as HTMLTextAreaElement | null;
  if (!drawer || !form || !text) return;
  const to = drawer.dataset.to ?? "";
  const page = drawer.dataset.page ?? document.title;

  drawer.addEventListener("toggle", () => {
    if (drawer.open) text.focus();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const subject = `Suggestion: ${page}`;
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.value.trim())}`;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.open) drawer.open = false;
  });
  document.addEventListener("click", (e) => {
    if (drawer.open && !drawer.contains(e.target as Node)) drawer.open = false;
  });
  wireAbout();
}

/** About drawer: closes on Escape, an outside click, or following one of its links. */
function wireAbout(): void {
  const about = document.getElementById("about-drawer") as HTMLDetailsElement | null;
  if (!about) return;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && about.open) about.open = false;
  });
  document.addEventListener("click", (e) => {
    if (about.open && (!about.contains(e.target as Node) || (e.target as HTMLElement).closest("a"))) about.open = false;
  });
}
