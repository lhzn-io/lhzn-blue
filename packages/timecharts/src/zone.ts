/** The time zone the charts and time tracks are drawn in: their labels, ticks and day boundaries. America/New_York
 * unless a site sets another, for the whole package with `setTimeZone` (once, before drawing) or for one chart or
 * track with its own `timeZone` option. Any IANA name works ("UTC", "Europe/Lisbon", "Pacific/Honolulu"). */

let zone = "America/New_York";

/** Set the package's time zone. Throws a RangeError for a name the browser does not know. */
export function setTimeZone(timeZone: string): void {
  zone = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

/** The package's time zone. */
export const getTimeZone = (): string => zone;

const cache = new WeakMap<Intl.DateTimeFormatOptions, Map<string, Intl.DateTimeFormat>>();

/** A formatter for `options` in a zone (the package's by default), made once per options object and zone. */
export function dtf(options: Intl.DateTimeFormatOptions, timeZone = zone): Intl.DateTimeFormat {
  let byZone = cache.get(options);
  if (!byZone) cache.set(options, (byZone = new Map()));
  let f = byZone.get(timeZone);
  if (!f) byZone.set(timeZone, (f = new Intl.DateTimeFormat("en-US", { ...options, timeZone })));
  return f;
}

const PARTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" };

/** Year, month (0-based), day, hour, minute and second of an instant (ms) on the zone's clock. */
function wall(ms: number, timeZone: string): [number, number, number, number, number, number] {
  const p: Record<string, number> = {};
  for (const x of dtf(PARTS, timeZone).formatToParts(ms)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return [p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second];
}

/** The zone's offset from UTC at an instant (ms), in ms (negative west of Greenwich). */
function offset(ms: number, timeZone: string): number {
  const s = Math.floor(ms / 1000) * 1000;
  return Date.UTC(...wall(s, timeZone)) - s;
}

/** Year, month (0-based) and day of an instant (epoch seconds) on the zone's calendar. */
export function zonedDate(t: number, timeZone = zone): [number, number, number] {
  const [y, m, d] = wall(t * 1000, timeZone);
  return [y, m, d];
}

/** Epoch seconds of midnight in the zone on a calendar date (month 0-based; days may overflow). */
export function zonedMidnight(y: number, m: number, d: number, timeZone = zone): number {
  const guess = Date.UTC(y, m, d);
  const first = guess - offset(guess, timeZone);
  return (guess - offset(first, timeZone)) / 1000; // again at the first answer, in case a clock change lies between
}
