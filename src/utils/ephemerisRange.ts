import moment from "moment-timezone";

// Matches Skyfield error for DE440s short kernel used in this project:
// "ephemeris segment only covers dates 1849-12-26 through 2150-01-22"
export const EPHEMERIS_START_UTC_MS = moment.utc("1849-12-26T00:00:00Z").valueOf();
export const EPHEMERIS_END_UTC_MS = moment.utc("2150-01-22T23:59:59Z").valueOf();

export function isWithinEphemerisRange(datetimeIso: string): boolean {
  if (!datetimeIso) return false;
  const ms = moment.parseZone(datetimeIso).valueOf();
  if (!Number.isFinite(ms)) return false;
  return ms >= EPHEMERIS_START_UTC_MS && ms <= EPHEMERIS_END_UTC_MS;
}

export function formatEphemerisRangeRu(): string {
  return "1849-12-26 … 2150-01-22";
}

