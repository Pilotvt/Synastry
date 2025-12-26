import type { NakshatraLordRu } from "./nakshatraJ2000";

export type VimshottariPlanetCode = "Ke" | "Ve" | "Su" | "Mo" | "Ma" | "Ra" | "Ju" | "Sa" | "Me";

export const VIMSHOTTARI_ORDER: readonly VimshottariPlanetCode[] = Object.freeze([
  "Ke",
  "Ve",
  "Su",
  "Mo",
  "Ma",
  "Ra",
  "Ju",
  "Sa",
  "Me",
]);

export const VIMSHOTTARI_YEARS: Readonly<Record<VimshottariPlanetCode, number>> = Object.freeze({
  Ke: 7,
  Ve: 20,
  Su: 6,
  Mo: 10,
  Ma: 7,
  Ra: 18,
  Ju: 16,
  Sa: 19,
  Me: 17,
});

export const VIMSHOTTARI_TOTAL_YEARS = 120;
export const VIMSHOTTARI_YEAR_DAYS = 365.2425;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function vimshottariPlanetFromNakshatraLord(lordRu: NakshatraLordRu): VimshottariPlanetCode {
  const map: Record<NakshatraLordRu, VimshottariPlanetCode> = {
    Кету: "Ke",
    Венера: "Ve",
    Солнце: "Su",
    Луна: "Mo",
    Марс: "Ma",
    Раху: "Ra",
    Юпитер: "Ju",
    Сатурн: "Sa",
    Меркурий: "Me",
  };
  return map[lordRu];
}

export function vimshottariCycleIndexOf(planet: VimshottariPlanetCode): number {
  const idx = VIMSHOTTARI_ORDER.indexOf(planet);
  return idx < 0 ? 0 : idx;
}

export function vimshottariCycleOrderFrom(planet: VimshottariPlanetCode): VimshottariPlanetCode[] {
  const start = vimshottariCycleIndexOf(planet);
  return [...VIMSHOTTARI_ORDER.slice(start), ...VIMSHOTTARI_ORDER.slice(0, start)];
}

export type VimshottariSlice = {
  lord: VimshottariPlanetCode;
  durationMs: number;
};

export function vimshottariMahaSlicesFrom(
  startLord: VimshottariPlanetCode,
  yearDays: number = VIMSHOTTARI_YEAR_DAYS,
): VimshottariSlice[] {
  const order = vimshottariCycleOrderFrom(startLord);
  return order.map((lord) => ({
    lord,
    durationMs: VIMSHOTTARI_YEARS[lord] * yearDays * DAY_MS,
  }));
}

export function vimshottariSubSlices(
  parentLord: VimshottariPlanetCode,
  parentDurationMs: number,
): VimshottariSlice[] {
  const order = vimshottariCycleOrderFrom(parentLord);
  return order.map((lord) => ({
    lord,
    durationMs: (parentDurationMs * VIMSHOTTARI_YEARS[lord]) / VIMSHOTTARI_TOTAL_YEARS,
  }));
}

export type VimshottariPeriod = {
  level: 1 | 2 | 3 | 4 | 5;
  path: VimshottariPlanetCode[];
  startMs: number;
  endMs: number;
};

export function findPeriodIndexContaining(
  periods: ReadonlyArray<{ startMs: number; endMs: number }>,
  targetMs: number,
): number {
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    const isLast = i === periods.length - 1;
    if (targetMs >= p.startMs && (targetMs < p.endMs || (isLast && targetMs <= p.endMs))) {
      return i;
    }
  }
  return 0;
}

