import { analyzeKujaDosha } from "./kuja";
import { applyKujaPenaltySimple } from "./kuja_simple";
import { affinityBySignDistance, ChartPayload, getAscSignCode, getPlanetHouse, scoreNumerology } from "./scoring";
import { WEIGHTS } from "./weights";
import { getExpressionCompatByDate } from "../numerology/exprDate/getExpressionByDate";
import { getAscCompatScore, type SignName } from "./ascCompatScores";
import { SIGN_NAMES_RU } from "./kuja";

type Gender = "male" | "female" | undefined | null;

export type DirectionalModule = {
  key:
    | "ascendant"
    | "moonToMoon"
    | "sunToSun"
    | "sunMoonCross"
    | "venusMars"
    | "numerology"
    | "numerologyExpr";
  title: string;
  weight: number;
  percent: number;
};

export type DirectionalSynastryResult = {
  basePercent: number;
  finalPercent: number;
  kujaPenalty: number;
  sunMoonBonus: number;
  modules: DirectionalModule[];
  hasSelfKuja: boolean;
  hasPartnerKuja: boolean;
};

type DirectionalSynastryInput = {
  selfChart: ChartPayload;
  partnerChart: ChartPayload;
  selfBirth?: string;
  partnerBirth?: string;
  selfGender?: Gender;
  partnerGender?: Gender;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const to01 = (raw: number) => clamp01((raw + 1) / 2);
const clampPercent = (value: number) => Math.round(clamp01(value) * 100);

const getHouseDistance = (
  fromChart: ChartPayload,
  fromCode: "Mo" | "Su" | "Ma" | "Ve",
  toChart: ChartPayload,
  toCode: "Mo" | "Su" | "Ma" | "Ve"
): number | null => {
  const fromHouse = getPlanetHouse(fromChart, fromCode);
  const toHouse = getPlanetHouse(toChart, toCode);
  if (!fromHouse || !toHouse) return null;
  const distance = ((toHouse - fromHouse + 12) % 12) + 1;
  return distance as number;
};

const moduleEntry = (
  key: DirectionalModule["key"],
  title: string,
  weight: number,
  rawScore: number
): DirectionalModule => ({
  key,
  title,
  weight,
  percent: Math.round(to01(rawScore) * weight * 100),
});

export function adjustSunMoonRaw(base: number): number {
  if (!Number.isFinite(base)) return 0;
  if (base >= 0.999) return 1;
  if (base <= -0.999) return -1;
  return base * 0.9;
}

export function computeDirectionalSynastry(input: DirectionalSynastryInput): DirectionalSynastryResult {
  const {
    selfChart,
    partnerChart,
    selfBirth,
    partnerBirth,
    selfGender,
    partnerGender,
  } = input;

  const modules: DirectionalModule[] = [];
  let total01 = 0;

  if (selfChart && partnerChart) {
    const ascSelf = getAscSignCode(selfChart);
    const ascPartner = getAscSignCode(partnerChart);
    if (ascSelf && ascPartner) {
      const nameSelf = SIGN_NAMES_RU[ascSelf] as SignName | undefined;
      const namePartner = SIGN_NAMES_RU[ascPartner] as SignName | undefined;
      if (nameSelf && namePartner) {
        const ascScore = getAscCompatScore(nameSelf, namePartner);
        if (typeof ascScore === "number") {
          const raw = (ascScore - 0.5) * 2;
          total01 += to01(raw) * WEIGHTS.ascendant;
          modules.push(moduleEntry("ascendant", "ASC×ASC", WEIGHTS.ascendant, raw));
        }
      }
    }

    const moonDistance = getHouseDistance(selfChart, "Mo", partnerChart, "Mo");
    if (moonDistance) {
      const raw = affinityBySignDistance(moonDistance - 1);
      total01 += to01(raw) * WEIGHTS.moonToMoon;
      modules.push(moduleEntry("moonToMoon", "Луна↔Луна", WEIGHTS.moonToMoon, raw));
    }

    const sunDistance = getHouseDistance(selfChart, "Su", partnerChart, "Su");
    if (sunDistance) {
      const raw = affinityBySignDistance(sunDistance - 1) * 0.8;
      total01 += to01(raw) * WEIGHTS.sunToSun;
      modules.push(moduleEntry("sunToSun", "Солнце↔Солнце", WEIGHTS.sunToSun, raw));
    }

    const sunToMoon = getHouseDistance(selfChart, "Su", partnerChart, "Mo");
    const moonToSun = getHouseDistance(selfChart, "Mo", partnerChart, "Su");
    const oppositeSex = (selfGender === "male" && partnerGender === "female") || (selfGender === "female" && partnerGender === "male");
    if (oppositeSex) {
      let chosenSunMoon: number | null = null;
      if (selfGender === "female" && partnerGender === "male") {
        chosenSunMoon = moonToSun;
      } else {
        chosenSunMoon = sunToMoon;
      }
      if (chosenSunMoon) {
        const base = affinityBySignDistance(chosenSunMoon - 1);
        const raw = adjustSunMoonRaw(base);
        total01 += to01(raw) * WEIGHTS.sunMoonCross;
        modules.push(moduleEntry("sunMoonCross", "Солнце↔Луна", WEIGHTS.sunMoonCross, raw));
      }
    }

    const venusToMars = getHouseDistance(selfChart, "Ve", partnerChart, "Ma");
    const marsToVenus = getHouseDistance(selfChart, "Ma", partnerChart, "Ve");
    if (oppositeSex) {
      let chosenVenusMars: number | null = venusToMars;
      if (selfGender === "male" && partnerGender === "female") {
        chosenVenusMars = marsToVenus;
      }
      if (chosenVenusMars) {
        const raw = affinityBySignDistance(chosenVenusMars - 1);
        total01 += to01(raw) * WEIGHTS.venusMars;
        modules.push(moduleEntry("venusMars", "Венера↔Марс", WEIGHTS.venusMars, raw));
      }
    }

    if (selfBirth && partnerBirth) {
      const numerology = scoreNumerology(selfBirth, partnerBirth);
      const numerologyRaw = numerology.raw;
      total01 += to01(numerologyRaw) * WEIGHTS.numerology;
      modules.push(moduleEntry("numerology", "Нумерология", WEIGHTS.numerology, numerologyRaw));

      try {
        const expr = getExpressionCompatByDate(selfBirth, partnerBirth);
        const expr01 = clamp01((expr.score ?? 0) / 100);
        total01 += expr01 * WEIGHTS.numerologyExpr;
        modules.push({
          key: "numerologyExpr",
          title: "Нумерология (экспрессия)",
          weight: WEIGHTS.numerologyExpr,
          percent: Math.round(expr01 * WEIGHTS.numerologyExpr * 100),
        });
      } catch {
        // ignore expression errors, keep silent for preview
      }
    }
  }

  const basePercent = clampPercent(total01);

  const selfKuja = analyzeKujaDosha(selfChart);
  const partnerKuja = analyzeKujaDosha(partnerChart);
  const hasSelfKuja = selfKuja.length > 0;
  const hasPartnerKuja = partnerKuja.length > 0;

  // Проверка на совпадение домов Солнца и Луны для бонуса
  let sunMoonBonus = 0;
  const selfSunHouse = getPlanetHouse(selfChart, "Su");
  const selfMoonHouse = getPlanetHouse(selfChart, "Mo");
  const partnerSunHouse = getPlanetHouse(partnerChart, "Su");
  const partnerMoonHouse = getPlanetHouse(partnerChart, "Mo");
  
  // Если Солнце одного партнёра и Луна другого в одном доме
  const sunMoonSameHouse = (selfSunHouse && partnerMoonHouse && selfSunHouse === partnerMoonHouse) ||
                           (selfMoonHouse && partnerSunHouse && selfMoonHouse === partnerSunHouse);
  
  const oppositeSex = (selfGender === 'male' && partnerGender === 'female') || (selfGender === 'female' && partnerGender === 'male');
  if (oppositeSex && sunMoonSameHouse) {
    sunMoonBonus = 10;
  }

  let finalPercent = basePercent;
  let kujaPenalty = 0;
  if (hasSelfKuja) {
    const penaltyResult = applyKujaPenaltySimple(basePercent, {
      hasA: hasSelfKuja,
      hasB: hasPartnerKuja,
    });
    finalPercent = penaltyResult.totalAfter;
    kujaPenalty = penaltyResult.penalty;
  }
  
  // Применяем бонус после штрафа Куджа-доши
  if (sunMoonBonus > 0) {
    finalPercent = Math.min(100, finalPercent + sunMoonBonus);
  }

  return {
    basePercent,
    finalPercent,
    kujaPenalty,
    sunMoonBonus,
    modules,
    hasSelfKuja,
    hasPartnerKuja,
  };
}
