/** The time bar, pinned under the top bar while its place above the map is out of sight: the same control moves into a
 * thin bar (play, the slider and the time; the month track, the step buttons and any rows placed with them stay
 * behind in the stylesheet), and back when its place scrolls into view. Its place keeps its height meanwhile, so the
 * page does not jump. */
export function pinTimeline(root: HTMLElement): void {
  const home = document.createElement("div");
  home.className = "tl-home";
  root.before(home);
  home.append(root);
  const bar = document.createElement("div");
  bar.className = "tl-pin";
  bar.hidden = true;
  document.body.append(bar);
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const below = () => topbar?.offsetHeight ?? 0;
  let pinned = false;
  const set = (on: boolean) => {
    if (on === pinned) return;
    pinned = on;
    if (on) {
      home.style.height = `${home.offsetHeight}px`;
      bar.style.top = `${below()}px`;
      bar.append(root);
    } else {
      home.append(root);
      home.style.height = "";
    }
    bar.hidden = !on;
    document.documentElement.classList.toggle("tl-pinned", on);
  };
  // Pinned once the whole of its place has passed under the top bar. Checked on scroll, once a frame: an observer
  // misses a jump (a link to a plot) that takes the place from below the screen to above it.
  let queued = false;
  const check = () => {
    queued = false;
    set(home.getBoundingClientRect().bottom <= below());
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", () => {
    if (pinned) bar.style.top = `${below()}px`;
    queue();
  });
  queue();
}
