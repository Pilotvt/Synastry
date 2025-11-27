/* eslint-disable @typescript-eslint/no-explicit-any */
// Charts arrive as heterogeneous JSON blobs from Supabase exports, so we keep pragmatic any-casts here
// until the payload schema is stabilized and formalized.
import { OVERLAY_RULES, type Planet as OverlayPlanet } from "./overlayRules";
import { WEIGHTS } from "./weights";
import { getAscCompatScore, type SignName } from "./ascCompatScores";

// Supported sign and planet codes used in charts
export type SignCode = "Ar"|"Ta"|"Ge"|"Cn"|"Le"|"Vi"|"Li"|"Sc"|"Sg"|"Cp"|"Aq"|"Pi";
export type PlanetCode = "Su"|"Mo"|"Ma"|"Me"|"Ju"|"Ve"|"Sa"|"Ra"|"Ke";

export type ChartPayload = Record<string, unknown> | null;

export type ModuleScore = {
  key:
    | "ascendant"
    | "moonToMoon"
    | "sunToSun"
    | "sunMoonCross"
    | "venusMars"
    | "overlays"
    | "nodes"
    | "numerology";
  title: string;
  weight: number;        // 0..1
  score01: number;       // mapped to 0..1 (−1..1 -> 0..1)
  raw: number;           // underlying raw in range −1..1
  details?: string[];    // human-readable notes
};

export type OverlayNote = {
  from: "left" | "right";  // direction (whose planet overlays partner's houses)
  label: string;             // e.g., "Юпитер→7"
  score: number;             // -6..+6
  reason: string;            // short text
  planet: OverlayPlanet;     // planet name code from overlay rules (Sun, Moon, ...)
  targetHouse: 1|2|3|4|5|6|7|8|9|10|11|12; // house number in partner's chart
};

export type SynastryReport = {
  total01: number;        // 0..1
  totalPercent: number;   // 0..100
  modules: ModuleScore[];
  overlays: OverlayNote[];
};

const SIGN_INDEX: Record<SignCode, number> = {
  Ar:0, Ta:1, Ge:2, Cn:3, Le:4, Vi:5, Li:6, Sc:7, Sg:8, Cp:9, Aq:10, Pi:11,
};

const SIGN_NAMES_RU: Record<SignCode, SignName> = {
  Ar: "Овен", Ta: "Телец", Ge: "Близнецы", Cn: "Рак", Le: "Лев", Vi: "Дева",
  Li: "Весы", Sc: "Скорпион", Sg: "Стрелец", Cp: "Козерог", Aq: "Водолей", Pi: "Рыбы",
};

const PLANET_MAP: Record<PlanetCode, OverlayPlanet> = {
  Su: "Sun", Mo: "Moon", Ma: "Mars", Me: "Mercury", Ju: "Jupiter", Ve: "Venus", Sa: "Saturn", Ra: "Rahu", Ke: "Ketu",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)); }

function to01(x: number) { // map from −1..1 to 0..1
  return clamp01((x + 1) / 2);
}

// Extract whole-sign ascendant sign from chart
export function getAscSignCode(chart: ChartPayload): SignCode | null {
  if (!isRecord(chart)) return null;
  const houses = (chart as any).houses;
  if (Array.isArray(houses)) {
    const h1 = houses.find((h: any) => isRecord(h) && Number(h.house) === 1);
    const code = h1 && typeof h1.sign === "string" ? h1.sign : undefined;
    if (code && code in SIGN_INDEX) return code as SignCode;
  }
  const asc = (chart as any).ascendant;
  if (isRecord(asc) && typeof (asc as any).sign === "string" && (asc as any).sign in SIGN_INDEX) {
    return (asc as any).sign as SignCode;
  }
  // nested chart fallback
  if (isRecord((chart as any).chart)) return getAscSignCode((chart as any).chart as Record<string, unknown>);
  return null;
}

export function getPlanetSignCode(chart: ChartPayload, code: PlanetCode): SignCode | null {
  const p = findPlanet(chart, code);
  if (p && typeof (p as any).sign === "string" && (p as any).sign in SIGN_INDEX) return (p as any).sign as SignCode;
  return null;
}

export function getPlanetHouse(chart: ChartPayload, code: PlanetCode): number | null {
  const p = findPlanet(chart, code);
  const h = p && (typeof (p as any).house === "number" ? (p as any).house : Number((p as any).house));
  return Number.isFinite(h) ? (h as number) : null;
}

export function getPlanetStrengthPct(chart: ChartPayload, code: PlanetCode): number | null {
  const p = findPlanet(chart, code);
  if (!p) return null;
  const s = Number((p as any).house_strength ?? (p as any).strength ?? 0);
  if (!Number.isFinite(s)) return null;
  return Math.max(0, Math.min(100, Math.round(s * 100)));
}

function findPlanet(chart: ChartPayload, code: PlanetCode) {
  const tryIn = (obj: Record<string, unknown>) => {
    const planets = (obj as any).planets;
    if (Array.isArray(planets)) return planets.find((p: any) => isRecord(p) && p.name === code) as Record<string, unknown> | undefined;
    return undefined;
  };
  if (!isRecord(chart)) return null;
  let found = tryIn(chart);
  if (found) return found;
  if (isRecord((chart as any).chart)) found = tryIn((chart as any).chart as Record<string, unknown>);
  return found ?? null;
}

// House index of targetSign relative to ascSign (whole-sign houses, 1..12)
export function signToHouse(ascSign: SignCode, targetSign: SignCode): number {
  const ascIdx = SIGN_INDEX[ascSign];
  const tgtIdx = SIGN_INDEX[targetSign];
  const d = (tgtIdx - ascIdx + 12) % 12; // 0..11
  return d + 1; // 1..12
}

// Ведическая система: совместимость по расстоянию домов (0..11)
// Основана на классификации домов: Триконы > Кендры > Упачайи > Дустханы
export function affinityBySignDistance(d: number): number {
  const dm = ((d % 12) + 12) % 12;
  
  // 1. Триконы – самые лучшие дома: 0, 4, 8 (1й, 5й, 9й)
  if (dm === 0) return 1.0;   // тот же знак (1й дом от партнёра) – идеально
  if (dm === 4) return 0.9;   // трикона (5й дом от партнёра) – отлично
  if (dm === 8) return 0.9;   // трикона (9й дом от партнёра) – отлично
  
  // 2. Кендры – очень хорошие дома: 0, 3, 6, 9 (1й, 4й, 7й, 10й)
  if (dm === 3) return 0.7;   // кендра (4й дом от партнёра) – очень хорошо
  if (dm === 6) return 0.6;   // кендра (7й дом от партнёра) – хорошо (партнёрство)
  if (dm === 9) return 0.7;   // кендра (10й дом от партнёра) – очень хорошо
  
  // 3. Упачайи – дома роста: 2, 5, 10, 11 (3й, 6й, 11й, 12й)
  if (dm === 2) return 0.4;   // упачайя (3й дом) – средне-положительно
  if (dm === 5) return 0.3;   // упачайя (6й дом) – средне (служение, но и конфликты)
  if (dm === 10) return 0.5;  // упачайя (11й дом) – хорошо (исполнение желаний)
  if (dm === 11) return 0.3;  // упачайя (12й дом) – слабо (потери, но и духовность)
  
  // 4. Дустханы – самые тяжёлые дома: 5, 7, 11 (6й, 8й, 12й)
  if (dm === 5) return -0.3;  // дустхана (6й дом) – сложно (уже учтено выше как упачайя, берём среднее)
  if (dm === 7) return -0.6;  // дустхана (8й дом) – тяжело (трансформации, кризисы)
  if (dm === 11) return -0.3; // дустхана (12й дом) – сложно (уже учтено выше, берём среднее)
  
  // 1й и 11й знаки (2й дом от партнёра) – нейтрально-положительно
  if (dm === 1) return 0.3;
  
  return 0; // остальные случаи нейтральны
}

function scoreAscendant(left: ChartPayload, right: ChartPayload): { raw: number; details: string[] } {
  const a = getAscSignCode(left); const b = getAscSignCode(right);
  if (!a || !b) return { raw: 0, details: ["ASC не определён — нейтрально"] };
  const aName = SIGN_NAMES_RU[a];
  const bName = SIGN_NAMES_RU[b];
  // Используем таблицу совместимости из JSON (уже проанализирована в ascCompatScores.ts)
  const score = getAscCompatScore(aName, bName); // диапазон 0..1 (уже нормализован)
  const raw = (score - 0.5) * 2; // преобразуем 0..1 в −1..+1
  return { raw, details: [
    `ASC/ASC: ${aName}×${bName} → совместимость ${Math.round(score*100)}% (score ${raw >= 0 ? '+' : ''}${raw.toFixed(2)})`
  ]};
}

function scoreMoonToMoon(left: ChartPayload, right: ChartPayload) {
  const aH = getPlanetHouse(left, "Mo"); const bH = getPlanetHouse(right, "Mo");
  if (!aH || !bH) return { raw: 0, details: ["Луна↔Луна: нет данных — нейтрально"] };
  const d1to12 = ((bH - aH + 12) % 12) + 1; // 1..12
  const raw = affinityBySignDistance(d1to12 - 1);
  return { raw, details: [`Луна↔Луна: дистанция ${d1to12} → ${raw >= 0 ? '+' : ''}${raw.toFixed(2)}`] };
}

function scoreSunToSun(left: ChartPayload, right: ChartPayload) {
  const aH = getPlanetHouse(left, "Su"); const bH = getPlanetHouse(right, "Su");
  if (!aH || !bH) return { raw: 0, details: ["Солнце↔Солнце: нет данных — нейтрально"] };
  const d1to12 = ((bH - aH + 12) % 12) + 1;
  const raw = affinityBySignDistance(d1to12 - 1) * 0.8; // чуть слабее Лунного
  return { raw, details: [`Солнце↔Солнце: дистанция ${d1to12} → ${raw >= 0 ? '+' : ''}${raw.toFixed(2)}`] };
}

function scoreSunMoonCross(left: ChartPayload, right: ChartPayload) {
  const aSuH = getPlanetHouse(left, "Su"); const bMoH = getPlanetHouse(right, "Mo");
  const bSuH = getPlanetHouse(right, "Su"); const aMoH = getPlanetHouse(left, "Mo");
  const details: string[] = [];
  let cnt = 0; let sum = 0;
  if (aSuH && bMoH) { const d1to12 = ((bMoH - aSuH + 12) % 12) + 1; const r = affinityBySignDistance(d1to12 - 1); sum += r; cnt++; details.push(`Солнце1→Луна2: d=${d1to12} → ${r >= 0 ? '+' : ''}${r.toFixed(2)}`); }
  if (bSuH && aMoH) { const d1to12 = ((aMoH - bSuH + 12) % 12) + 1; const r = affinityBySignDistance(d1to12 - 1); sum += r; cnt++; details.push(`Солнце2→Луна1: d=${d1to12} → ${r >= 0 ? '+' : ''}${r.toFixed(2)}`); }
  if (!cnt) return { raw: 0, details: ["Солнце↔Луна: нет данных — нейтрально"] };
  const base = sum / cnt;
  const raw = adjustSunMoonRawBase(base);
  return { raw, details };
}

function adjustSunMoonRawBase(base: number): number {
  if (!Number.isFinite(base)) return 0;
  if (base >= 0.999) return 1;
  if (base <= -0.999) return -1;
  return base * 0.9;
}

function scoreVenusMars(left: ChartPayload, right: ChartPayload) {
  const aVeH = getPlanetHouse(left, "Ve"); const bMaH = getPlanetHouse(right, "Ma");
  const bVeH = getPlanetHouse(right, "Ve"); const aMaH = getPlanetHouse(left, "Ma");
  const details: string[] = [];
  let cnt = 0; let sum = 0;
  if (aVeH && bMaH) { const d1to12 = ((bMaH - aVeH + 12) % 12) + 1; const r = affinityBySignDistance(d1to12 - 1); sum += r; cnt++; details.push(`Венера1→Марс2: d=${d1to12} → ${r >= 0 ? '+' : ''}${r.toFixed(2)}`); }
  if (bVeH && aMaH) { const d1to12 = ((aMaH - bVeH + 12) % 12) + 1; const r = affinityBySignDistance(d1to12 - 1); sum += r; cnt++; details.push(`Венера2→Марс1: d=${d1to12} → ${r >= 0 ? '+' : ''}${r.toFixed(2)}`); }
  if (!cnt) return { raw: 0, details: ["Венера↔Марс: нет данных — нейтрально"] };
  const raw = sum / cnt;
  return { raw, details };
}

function fmt(x: number) { return `${x >= 0 ? '+' : ''}${x.toFixed(2)}`; }

export function scoreNumerology(leftProfileBirth?: string, rightProfileBirth?: string) {
  // Placeholder: if both birth-dates exist, compare day-of-month parity and distance
  const details: string[] = [];
  const a = leftProfileBirth ? new Date(leftProfileBirth) : null;
  const b = rightProfileBirth ? new Date(rightProfileBirth) : null;
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return { raw: 0, details: ["Нумерология: пока нейтрально"] };
  const da = a.getDate(); const db = b.getDate();
  let raw = 0;
  if ((da % 2) === (db % 2)) { raw += 0.2; details.push("Обе даты одной чётности: +0.20"); }
  const diff = Math.abs(da - db);
  if (diff === 0 || diff === 9) { raw += 0.2; details.push(`Дневной дифференциал ${diff}: +0.20`); }
  if (diff === 1 || diff === 11) { raw += 0.1; details.push(`Дневной дифференциал ${diff}: +0.10`); }
  raw = clamp(raw, -1, 1);
  if (!details.length) details.push("Нумерология: нейтрально");
  return { raw, details };
}

export function scoreOverlays(left: ChartPayload, right: ChartPayload) {
  // Новый подход: берём номер дома планеты из исходной карты и переносим его напрямую в дома партнёра
  const notes: OverlayNote[] = [];
  let sum = 0; let cnt = 0;

  const scan = (who: "left" | "right", src: ChartPayload) => {
    const planets = collectPlanetHouses(src);
    for (const [code, house] of planets) {
      const overlayPlanet = PLANET_MAP[code];
      if (!overlayPlanet) continue;
      const rule = OVERLAY_RULES.find(r => r.planet === overlayPlanet && r.targetHouse === (house as any));
      if (rule) {
        sum += rule.score; cnt++;
        notes.push({ from: who, label: rule.label, score: rule.score, reason: rule.reason, planet: overlayPlanet, targetHouse: house as any });
      }
    }
  };

  scan("left", left);
  scan("right", right);
  const cap = 60; // normalization cap for sum of scores
  const raw = cnt ? clamp(sum / cap, -1, 1) : 0;
  return { raw, notes };
}

function collectPlanetHouses(chart: ChartPayload): Array<[PlanetCode, number]> {
  const out: Array<[PlanetCode, number]> = [];
  const tryCollect = (obj: Record<string, unknown>) => {
    const planets = (obj as any).planets;
    if (!Array.isArray(planets)) return;
    for (const p of planets) {
      if (!isRecord(p) || typeof (p as any).name !== 'string') continue;
      const name = (p as any).name as string;
      const house = typeof (p as any).house === 'number' ? (p as any).house : Number((p as any).house);
      if ((["Su","Mo","Ma","Me","Ju","Ve","Sa","Ra","Ke"] as string[]).includes(name) && Number.isFinite(house) && house >= 1 && house <= 12) {
        out.push([name as PlanetCode, house as number]);
      }
    }
  };
  if (isRecord(chart)) tryCollect(chart);
  if (isRecord(chart) && isRecord((chart as any).chart)) tryCollect((chart as any).chart as Record<string, unknown>);
  return out;
}

export function scoreSynastry(
  left: ChartPayload,
  right: ChartPayload,
  leftProfile?: { birth?: string; gender?: "male" | "female" },
  rightProfile?: { birth?: string; gender?: "male" | "female" }
): SynastryReport {
  const modules: ModuleScore[] = [];

  // 1) ASC×ASC
  {
    const r = scoreAscendant(left, right);
    modules.push({ key: "ascendant", title: "ASC×ASC", weight: WEIGHTS.ascendant, raw: r.raw, score01: to01(r.raw), details: r.details });
  }

  // 2) Луна↔Луна
  {
    const r = scoreMoonToMoon(left, right);
    modules.push({ key: "moonToMoon", title: "Луна↔Луна", weight: WEIGHTS.moonToMoon, raw: r.raw, score01: to01(r.raw), details: r.details });
  }

  // 3) Солнце↔Солнце
  {
    const r = scoreSunToSun(left, right);
    modules.push({ key: "sunToSun", title: "Солнце↔Солнце", weight: WEIGHTS.sunToSun, raw: r.raw, score01: to01(r.raw), details: r.details });
  }

  // 4) Солнце↔Луна (в обе стороны)
  {
    const r = scoreSunMoonCross(left, right);
    modules.push({ key: "sunMoonCross", title: "Солнце↔Луна", weight: WEIGHTS.sunMoonCross, raw: r.raw, score01: to01(r.raw), details: r.details });
  }

  // 5) Венера↔Марс
  {
    const r = scoreVenusMars(left, right);
    modules.push({ key: "venusMars", title: "Венера↔Марс", weight: WEIGHTS.venusMars, raw: r.raw, score01: to01(r.raw), details: r.details });
  }

  // 6) Оверлеи планета→дом
  const overlay = scoreOverlays(left, right);
  modules.push({ key: "overlays", title: "Оверлеи", weight: WEIGHTS.overlays, raw: overlay.raw, score01: to01(overlay.raw), details: overlay.notes.map(n => `${n.from === 'left' ? '1→2' : '2→1'} ${n.label}: ${fmt(ruleToUnit(n.score))} — ${n.reason}`) });

  // Узлы теперь считаются в overlays вместе с остальными планетами

  // 8) Нумерология (плейсхолдер)
  {
    const r = scoreNumerology(leftProfile?.birth, rightProfile?.birth);
    modules.push({ key: "numerology", title: "Нумерология", weight: WEIGHTS.numerology, raw: r.raw, score01: to01(r.raw), details: r.details });
  }

  // Enforce gender gating at the scoring layer as well
  const gL = (leftProfile as any)?.gender as ("male" | "female" | undefined);
  const gR = (rightProfile as any)?.gender as ("male" | "female" | undefined);
  const oppositeSex = (gL === "male" && gR === "female") || (gL === "female" && gR === "male");
  const effectiveModules = oppositeSex
    ? modules
    : modules.filter(m => m.key !== "sunMoonCross" && m.key !== "venusMars");

  const total01 = clamp01(effectiveModules.reduce((acc, m) => acc + m.score01 * m.weight, 0));
  const totalPercent = Math.round(total01 * 100);

  return {
    total01,
    totalPercent,
    modules: effectiveModules,
    overlays: overlay.notes,
  };
}

function ruleToUnit(score: number): number {
  // Map −6..+6 to −1..+1 roughly
  return clamp(score / 6, -1, 1);
}
