// ===== Типы и утилиты расстояний =====
export type DistCat = "TRIKONA"|"KENDRA"|"UPACHAYA"|"DUSTHANA"|"MIXED";

// Опорные множества (пересечения учитываем при приоритете)
const TRIKONA = new Set([1,5,9]);
const KENDRA  = new Set([1,4,7,10]);
const UPACHAYA= new Set([3,6,10,11]);
const DUSTHANA= new Set([6,8,12]);

/** Категория по числу домов (1..12). Спец-приоритет: 1→TRIKONA, 10→KENDRA, 6→DUSTHANA. */
export function distCategory(d: 1|2|3|4|5|6|7|8|9|10|11|12): DistCat {
  if (d === 1) return "TRIKONA";     // супер-плюс (также Кендра)
  if (d === 10) return "KENDRA";     // плюс с оттенком роста (ещё и Упачая)
  if (d === 6) return "DUSTHANA";    // напряжение, хоть и Упачая
  if ((DUSTHANA as Set<number>).has(d)) return "DUSTHANA";
  if ((TRIKONA as Set<number>).has(d))  return "TRIKONA";
  if ((KENDRA as Set<number>).has(d))   return "KENDRA";
  if ((UPACHAYA as Set<number>).has(d)) return "UPACHAYA";
  return "MIXED";
}

const rank = (c: DistCat) => ({TRIKONA:3,KENDRA:2,UPACHAYA:1,DUSTHANA:0,MIXED:1}[c]);

// ===== MOON vs MOON — эмоции/эмпатия (без направленности) =====
export const MOON_VS_MOON: Record<DistCat,string> = {
  TRIKONA: "Сильный эмоциональный резонанс и естественная поддержка.",
  KENDRA:  "Опора и стабильность в чувствах; легко полагаться друг на друга.",
  UPACHAYA:"Совместимость растущая: теплеет через общение, режим и совместный быт.",
  DUSTHANA:"Эмоциональные узкие места: тревожность/секреты/отстранённость — нужна работа.",
  MIXED:   "Смешанный рисунок эмоций; уточняем по остальным факторам."
};

export function describeMoonMoon(d: 1|2|3|4|5|6|7|8|9|10|11|12): string {
  return MOON_VS_MOON[distCategory(d)];
}

function moonMoonPairTail(cA: DistCat, cB: DistCat): string {
  const has = (x: DistCat) => cA === x || cB === x;
  if (has("DUSTHANA")) return " Есть риск эмоциональных трений; помогает честный и бережный диалог.";
  if (cA === "TRIKONA" && cB === "TRIKONA") return " Очень гармонично: взаимная поддержка по умолчанию.";
  if (has("TRIKONA") && has("KENDRA")) return " Гармония + устойчивая опора; чувства проявляются естественно.";
  if (cA === "KENDRA" && cB === "KENDRA") return " Устойчивая опора; эмоции держатся крепко при понятных правилах.";
  if (has("KENDRA") && has("UPACHAYA")) return " Опора + рост: быт и режим со временем только улучшают контакт.";
  if (has("TRIKONA") && has("UPACHAYA")) return " Гармония с потенциалом роста: теплее и понятнее с опытом.";
  if (cA === "UPACHAYA" && cB === "UPACHAYA") return " Скорее симпатия/привязанность, усиливается практикой.";
  return "";
}

export function moonMoonVerdict(
  dAB: 1|2|3|4|5|6|7|8|9|10|11|12,
  dBA: 1|2|3|4|5|6|7|8|9|10|11|12
): string {
  const cA = distCategory(dAB), cB = distCategory(dBA);
  const r = rank(cA) + rank(cB);
  const head = r>=5 ? "Сильная эмоциональная совместимость."
            : r>=3 ? "Средняя/растущая эмоциональная совместимость."
                   : "Слабая или неоднородная эмоциональная совместимость.";
  return [head, describeMoonMoon(dAB), describeMoonMoon(dBA), moonMoonPairTail(cA,cB)]
    .filter(Boolean).join(" ");
}

// ===== SUN vs SUN — эго/воля/роль (без направленности) =====
export const SUN_VS_SUN: Record<DistCat,string> = {
  TRIKONA: "Воля звучит созвучно; меньше борьбы за центр, больше признания заслуг.",
  KENDRA:  "Сильная связка лидерства; важно заранее согласовать роли и правила.",
  UPACHAYA:"Лидерство согласуется через рост и общие цели/проекты.",
  DUSTHANA:"Риск эго-трений или скрытой конкуренции; помогают осознанность и границы.",
  MIXED:   "Смешанная динамика воли; смотрим дополнительные показатели."
};

export function describeSunSun(d: 1|2|3|4|5|6|7|8|9|10|11|12): string {
  return SUN_VS_SUN[distCategory(d)];
}

function sunSunPairTail(cA: DistCat, cB: DistCat): string {
  const has = (x: DistCat) => cA === x || cB === x;
  if (has("DUSTHANA")) return " Есть риск тянущихся эго-конфликтов; выручат правила и уважение ролей.";
  if (cA === "TRIKONA" && cB === "TRIKONA") return " Очень созвучное лидерство; мотивируете друг друга.";
  if (has("TRIKONA") && has("KENDRA")) return " Гармония + устойчивая управленческая опора.";
  if (cA === "KENDRA" && cB === "KENDRA") return " Крепкая управленческая связка; роли стоит зафиксировать.";
  if (has("KENDRA") && has("UPACHAYA")) return " Опора + рост: лидерство крепнет по мере опыта.";
  if (has("TRIKONA") && has("UPACHAYA")) return " Созвучие с потенциалом развития общих целей.";
  if (cA === "UPACHAYA" && cB === "UPACHAYA") return " Растущая связка: дисциплина и практика согласуют волю.";
  return "";
}

export function sunSunVerdict(
  dAB: 1|2|3|4|5|6|7|8|9|10|11|12,
  dBA: 1|2|3|4|5|6|7|8|9|10|11|12
): string {
  const cA = distCategory(dAB), cB = distCategory(dBA);
  const r = rank(cA) + rank(cB);
  const head = r>=5 ? "Сильная связка Солнце–Солнце."
            : r>=3 ? "Средняя/растущая связка Солнце–Солнце."
                   : "Слабая или фрагментарная связка Солнце–Солнце.";
  return [head, describeSunSun(dAB), describeSunSun(dBA), sunSunPairTail(cA,cB)]
    .filter(Boolean).join(" ");
}

// ===== SUN → MOON и MOON → SUN — направленность (любовь с первого взгляда при d=1) =====
export const SUN_TO_MOON: Record<DistCat,string> = {
  TRIKONA: "Солнце даёт Луне тепло и уверенность; чувства раскрываются естественно.",
  KENDRA:  "Стабильная связка воли и эмоций; легко договориться «кто ведёт/кто поддерживает».",
  UPACHAYA:"Созвучие растёт через совместные цели и дисциплину; помогает открытый диалог.",
  DUSTHANA:"Диссонанс эго и чувств: критичность (6), скрытая борьба (8), отстранённость (12).",
  MIXED:   "Сигнал смешанный; уточняем по прочим факторам."
};

export const MOON_TO_SUN: Record<DistCat,string> = {
  TRIKONA: "Луна питает Солнце: принятие, забота, восхищение — эго смягчается.",
  KENDRA:  "Надёжная «эмоциональная опора» для лидерства; легче проявлять волю экологично.",
  UPACHAYA:"Тепло нарастает по мере общего быта и практик; помогает режим/ритуалы.",
  DUSTHANA:"Луне трудно поддерживать Солнце: мелкие уколы (6), недоверие (8), дистанция (12).",
  MIXED:   "Смешанная динамика; важно смотреть контекст."
};

function sunMoonPairTail(cStoM: DistCat, cMtoS: DistCat): string {
  const has = (x: DistCat) => cStoM === x || cMtoS === x;

  if (has("DUSTHANA")) {
    return " Есть риск эмоциональных трений: поможет осознанность и честный диалог.";
  }
  if (cStoM === "TRIKONA" && cMtoS === "TRIKONA") {
    return " Очень гармонично: взаимное признание и тёплая поддержка.";
  }
  if (has("TRIKONA") && has("KENDRA")) {
    return " Сильная связка: гармония плюс устойчивая опора (роли легко согласовать).";
  }
  if (cStoM === "KENDRA" && cMtoS === "KENDRA") {
    return " Устойчивая опора; заранее проговорить роли и правила — и всё держится крепко.";
  }
  if (has("KENDRA") && has("UPACHAYA")) {
    return " Опора + рост: договорённости укрепляются практикой и общими целями.";
  }
  if (has("TRIKONA") && has("UPACHAYA")) {
    return " Гармония с потенциалом роста: со временем становится теплее и понятнее.";
  }
  if (cStoM === "UPACHAYA" && cMtoS === "UPACHAYA") {
    return " Скорее симпатия/привязанность, усиливается совместной практикой.";
  }
  return "";
}

/** Описание одного направления с пометкой о «любви с первого взгляда» при d=1. */
export function describeSunMoon(
  direction: "StoM"|"MtoS",
  d: 1|2|3|4|5|6|7|8|9|10|11|12
): string {
  const cat = distCategory(d);
  const base = direction === "StoM" ? SUN_TO_MOON[cat] : MOON_TO_SUN[cat];
  const loveAtFirstSight = (d === 1 && (cat === "TRIKONA" || cat === "KENDRA"))
    ? " Возможна «любовь с первого взгляда»."
    : "";
  return base + loveAtFirstSight;
}

/** Сводный вердикт по паре направлений SUN↔MOON. */
export function sunMoonVerdict(
  dStoM: 1|2|3|4|5|6|7|8|9|10|11|12, // от Солнца A к Луне B
  dMtoS: 1|2|3|4|5|6|7|8|9|10|11|12  // от Луны A к Солнцу B
): string {
  const cStoM = distCategory(dStoM);
  const cMtoS = distCategory(dMtoS);
  const score = rank(cStoM) + rank(cMtoS);

  const head =
    score >= 5 ? "Сильная связка Солнце–Луна."
  : score >= 3 ? "Средняя/растущая связка Солнце–Луна."
               : "Слабая или фрагментарная связка Солнце–Луна.";

  const noteLove = (dStoM === 1 || dMtoS === 1) ? " Возможна «любовь с первого взгляда»." : "";
  const tail = sunMoonPairTail(cStoM, cMtoS);

  const dirA = describeSunMoon("StoM", dStoM); // Солнце A → Луна B
  const dirB = describeSunMoon("MtoS", dMtoS); // Луна A → Солнце B
  return [head + noteLove, dirA, dirB, tail].filter(Boolean).join(" ");
}

// ===== VENUS ↔ MARS — сексуальная совместимость (направленность) =====
// ВЕНЕРА → МАРС: вкусы/притяжение Венеры к драйву Марса партнёра
export const VENUS_TO_MARS: Record<DistCat,string> = {
  TRIKONA: "Сильное взаимное влечение; вкусы Венеры отлично резонируют с драйвом Марса.",
  KENDRA:  "Стабильная тяга и «магнит»; важно договориться о ритме и инициативе.",
  UPACHAYA:"Притяжение нарастает с опытом; разговоры о предпочтениях улучшают синхрон.",
  DUSTHANA:"Срыв ритма и непопадание во вкус; может не быть обоюдности без работы.",
  MIXED:   "Смешанный сигнал; многое решает открытое обсуждение желаний."
};

// МАРС → ВЕНЕРА: инициатива/энергия Марса попадает ли во «вкус» Венеры партнёра
export const MARS_TO_VENUS: Record<DistCat,string> = {
  TRIKONA: "Инициатива Марса попадает «в точку» вкусов Венеры; страсть и лёгкий отклик.",
  KENDRA:  "Хорошая тяга и устойчивость; распределить роли «кто начинает/кто задаёт тон».",
  UPACHAYA:"Совместимость усиливается практикой; обсуждать темп и форматы близости.",
  DUSTHANA:"Расфазировка желаний; один хочет — другой нет, регулярность не совпадает.",
  MIXED:   "Сигнал неоднозначный; помогут простые правила и бережная обратная связь."
};

export function describeVenusMars(
  direction: "VtoM"|"MtoV",
  d: 1|2|3|4|5|6|7|8|9|10|11|12
): string {
  const cat = distCategory(d);
  return direction === "VtoM" ? VENUS_TO_MARS[cat] : MARS_TO_VENUS[cat];
}

/** Сводный вердикт по паре направлений MARS↔VENUS. */
export function marsVenusVerdict(
  dVM: 1|2|3|4|5|6|7|8|9|10|11|12, // Венера A → Марс B
  dMV: 1|2|3|4|5|6|7|8|9|10|11|12  // Марс A → Венера B
): string {
  const cVM = distCategory(dVM), cMV = distCategory(dMV);
  const txtVM = describeVenusMars("VtoM", dVM);
  const txtMV = describeVenusMars("MtoV", dMV);

  const score = rank(cVM) + rank(cMV);
  const head =
    score >= 5 ? "Сильная сексуальная совместимость."
  : score >= 3 ? "Средняя/растущая сексуальная совместимость."
               : "Слабая или неоднородная сексуальная совместимость.";

  const tail =
    (cVM==="DUSTHANA" && cMV==="TRIKONA")
      ? " Возможна неоднородность: один партнёр желает, другой — нет; ритм не совпадает."
      : (cVM==="TRIKONA" && cMV==="DUSTHANA")
      ? " Тяга есть, но периодически даёт расфазировку; обсуждайте ритм и предпочтения."
      : "";

  return [head, txtVM, txtMV, tail].filter(Boolean).join(" ");
}
