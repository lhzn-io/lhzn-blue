/** "Use my location": off by default. Only when the reader turns it on does the browser ask for the location, once per
 * visit; the map then opens on their part of the waterway. The location is used in this browser only and never sent. */
export function wireLocate(waterway: string): void {
  const btn = document.querySelector<HTMLButtonElement>('[data-more="locate"]');
  if (!btn || !("geolocation" in navigator)) {
    btn?.remove();
    return;
  }
  let on = false;
  try {
    on = localStorage.getItem("lhzn-blue-locate") === "1";
  } catch {
    /* private mode: off */
  }
  const label = (note = "") => {
    btn.textContent = `Use my location: ${on ? "on" : "off"}${note}`;
    btn.setAttribute("aria-pressed", String(on));
  };
  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const near = await (await import("../map")).focusOn({ lon: pos.coords.longitude, lat: pos.coords.latitude });
        label(near ? "" : ` (not near ${waterway})`);
      },
      () => label(" (not available)"),
      { maximumAge: 10 * 60_000, timeout: 10_000, enableHighAccuracy: false },
    );
  label();
  if (on) locate();
  btn.addEventListener("click", async () => {
    on = !on;
    try {
      if (on) localStorage.setItem("lhzn-blue-locate", "1");
      else localStorage.removeItem("lhzn-blue-locate");
    } catch {
      /* private mode: for this visit only */
    }
    label();
    if (on) locate();
    else void (await import("../map")).focusOn(null);
  });
}
