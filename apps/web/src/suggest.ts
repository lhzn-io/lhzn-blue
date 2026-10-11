/** The About drawer at the top of the page: closes on Escape, an outside click, or following one of its links.
 * (Suggestions now go through Collect: see collect.ts.) */
export function wireSuggest(): void {
  const about = document.getElementById("about-drawer") as HTMLDetailsElement | null;
  if (!about) return;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && about.open) about.open = false;
  });
  document.addEventListener("click", (e) => {
    if (about.open && (!about.contains(e.target as Node) || (e.target as HTMLElement).closest("a"))) about.open = false;
  });
}
