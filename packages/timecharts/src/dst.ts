/**
 * Eastern time across the clock changes. On the night the clocks fall back (the first Sunday of November) the 1 AM
 * hour happens twice, first in daylight time and then in standard time, so a time in that hour is labelled with its
 * zone ("Sun 1 AM EDT", then "Sun 1 AM EST"); every other time is labelled as before. On the night the clocks spring
 * forward (the second Sunday of March) the 2 AM hour does not happen, and Intl's labels already skip it.
 */
const TZ = "America/New_York";
const HOUR_MS = 3_600_000;
const etHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const etZone = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" });

/** Whether an instant (ms) falls in the hour the clocks repeat: the same clock hour an hour before or after it. */
export function repeatedHour(ms: number): boolean {
  const h = etHour.format(ms);
  return h === etHour.format(ms - HOUR_MS) || h === etHour.format(ms + HOUR_MS);
}

/** " EDT" or " EST" for an instant in the repeated hour; "" otherwise. */
export function zoneTag(ms: number): string {
  if (!repeatedHour(ms)) return "";
  return ` ${etZone.formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? ""}`;
}

/** An Eastern-time formatter whose labels name the zone in the repeated hour (see above). */
export function zoned(f: { format(d: Date | number): string }): { format(d: Date | number): string } {
  return { format: (d) => f.format(d) + zoneTag(typeof d === "number" ? d : d.getTime()) };
}
