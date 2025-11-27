import type { ChartPayload } from "./scoring";

const SIGN_NAMES_RU: Record<string, string> = {
  Ar: "Овен",
  Ta: "Телец",
  Ge: "Близнецы",
  Cn: "Рак",
  Le: "Лев",
  Vi: "Дева",
  Li: "Весы",
  Sc: "Скорпион",
  Sg: "Стрелец",
  Cp: "Козерог",
  Aq: "Водолей",
  Pi: "Рыбы",
} as const;

const DOSHA_HOUSES = new Set<number>([1, 4, 7, 8, 12]);

type RawPlanet = Record<string, unknown> & {
  name?: unknown;
  house?: unknown;
  sign?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeHouse(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeSign(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function signLabel(signCode: string): string {
  return SIGN_NAMES_RU[signCode as keyof typeof SIGN_NAMES_RU] ?? signCode;
}

function collectPlanets(chartValue: ChartPayload | unknown): RawPlanet[] {
  if (!isRecord(chartValue)) return [];

  const seen = new Set<object>();
  const result: RawPlanet[] = [];
  type StackEntry = { value: Record<string, unknown>; depth: number };
  const stack: StackEntry[] = [{ value: chartValue, depth: 0 }];

  const shouldDiveIntoKey = (key: string) => {
    const lower = key.toLowerCase();
    return lower.includes('chart') || lower.includes('payload') || lower.includes('data');
  };

  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (seen.has(value) || depth > 4) continue;
    seen.add(value);

    const directPlanets = value['planets'];
    if (Array.isArray(directPlanets)) {
      for (const candidate of directPlanets) {
        if (isRecord(candidate)) {
          result.push(candidate);
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'planets') continue;
      if (Array.isArray(child)) {
        if (!shouldDiveIntoKey(key)) continue;
        for (const item of child) {
          if (isRecord(item)) {
            stack.push({ value: item, depth: depth + 1 });
          }
        }
        continue;
      }
      if (isRecord(child) && shouldDiveIntoKey(key)) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return result;
}

export type KujaDosha = {
  hasDosha: boolean;
  isRashi: boolean; // false = Lagna (Ascendant), true = Chandra Lagna
  house: number;
  sign: string;
  signCode?: string;
  mitigatingFactors: string[];
};

export function analyzeKujaDosha(chartValue: ChartPayload | unknown): KujaDosha[] {
  const results: KujaDosha[] = [];
  const planets = collectPlanets(chartValue);
  if (!planets.length) return results;

  const mars = planets.find((p) => p?.name === "Ma");
  if (!mars) return results;

  const moon = planets.find((p) => p?.name === "Mo");

  const marsHouse = normalizeHouse(mars.house);
  const marsSign = normalizeSign(mars.sign);

  if (marsHouse !== null && DOSHA_HOUSES.has(marsHouse)) {
    const mitigating = buildMitigatingFactors(marsHouse, marsSign, false);
    results.push({
      hasDosha: true,
      isRashi: false,
      house: marsHouse,
      sign: signLabel(marsSign),
      signCode: marsSign,
      mitigatingFactors: mitigating,
    });
  }

  if (moon) {
    const moonHouse = normalizeHouse(moon.house);
    if (moonHouse !== null && marsHouse !== null) {
      let relativeHouse = marsHouse - moonHouse + 1;
      while (relativeHouse <= 0) relativeHouse += 12;
      while (relativeHouse > 12) relativeHouse -= 12;

      if (DOSHA_HOUSES.has(relativeHouse)) {
        const mitigating = buildMitigatingFactors(relativeHouse, marsSign, true);
        results.push({
          hasDosha: true,
          isRashi: true,
          house: relativeHouse,
          sign: signLabel(marsSign),
          signCode: marsSign,
          mitigatingFactors: mitigating,
        });
      }
    }
  }

  return results;
}

function buildMitigatingFactors(house: number, signCode: string, fromMoon: boolean): string[] {
  const scope = fromMoon ? "от Луны" : "";
  const factors: string[] = [];

  if (house === 1 && signCode === "Ar") {
    factors.push(`Марс находится в 1 доме ${scope ? scope + " " : ""}в Овне (в своём знаке)`);
  }
  if (house === 4 && signCode === "Sc") {
    factors.push(`Марс находится в 4 доме ${scope ? scope + " " : ""}в Скорпионе (в своём знаке)`);
  }
  if (house === 7 && (signCode === "Pi" || signCode === "Cp")) {
    if (signCode === "Cp") {
      factors.push(`Марс находится в 7 доме ${scope ? scope + " " : ""}в Козероге (экзальтация)`);
    } else {
      factors.push(`Марс находится в 7 доме ${scope ? scope + " " : ""}в Рыбах`);
    }
  }
  if (house === 8 && signCode === "Cn") {
    factors.push(`Марс находится в 8 доме ${scope ? scope + " " : ""}в Раке (дебилитация)`);
  }
  if (house === 12 && signCode === "Sg") {
    factors.push(`Марс находится в 12 доме ${scope ? scope + " " : ""}в Стрельце`);
  }

  return factors;
}

export function hasKujaDosha(chartValue: ChartPayload | unknown): boolean {
  return analyzeKujaDosha(chartValue).length > 0;
}

export { SIGN_NAMES_RU };
