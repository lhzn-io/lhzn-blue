/**
 * Local time across the clock changes, in the package's time zone (Eastern time unless set; see `zone`). On the
 * night the clocks fall back (in Eastern time, the first Sunday of November) the hour before the change happens
 * twice, first in daylight time and then in standard time, so a time in that hour is labelled with its zone
 * ("Sun 1 AM EDT", then "Sun 1 AM EST"); every other time is labelled as before. On the night the clocks spring
 * forward the skipped hour does not happen, and Intl's labels already skip it.
 */
import { dtf, getTimeZone } from "./zone.js";

const HOUR_MS = 3_600_000;
const HOUR: Intl.DateTimeFormatOptions = { hour: "numeric", hourCycle: "h23" };
const ZONE: Intl.DateTimeFormatOptions = { timeZoneName: "short" };

/** Whether an instant (ms) falls in the hour the clocks repeat: the same clock hour an hour before or after it. */
export function repeatedHour(ms: number, timeZone = getTimeZone()): boolean {
  const f = dtf(HOUR, timeZone);
  const h = f.format(ms);
  return h === f.format(ms - HOUR_MS) || h === f.format(ms + HOUR_MS);
}

/** " EDT" or " EST" (the zone's own abbreviation) for an instant in the repeated hour; "" otherwise. */
export function zoneTag(ms: number, timeZone = getTimeZone()): string {
  if (!repeatedHour(ms, timeZone)) return "";
  return ` ${dtf(ZONE, timeZone).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? ""}`;
}

/** A formatter whose labels name the zone in the repeated hour (see above). An Intl.DateTimeFormat is checked in
 * its own zone, any other formatter in `timeZone` (the package's zone by default). */
export function zoned(f: { format(d: Date | number): string }, timeZone?: string): { format(d: Date | number): string } {
  const own = f instanceof Intl.DateTimeFormat ? f.resolvedOptions().timeZone : undefined;
  return { format: (d) => f.format(d) + zoneTag(typeof d === "number" ? d : d.getTime(), timeZone ?? own ?? getTimeZone()) };
}
