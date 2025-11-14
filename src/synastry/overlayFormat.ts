export type Planet =
  | "Sun" | "Moon" | "Mars" | "Mercury" | "Jupiter" | "Venus" | "Saturn" | "Rahu" | "Ketu";

export type OverlayRule = {
  planet: Planet;
  targetHouse: 1|2|3|4|5|6|7|8|9|10|11|12;
  score: number;
  label: string;   // напр. "Шукра→5"
  reason: string;  // мой текст-объяснение
};

export type NameForms = {
  srcNom: string;  // кто даёт (Именительный)   — "Виталий"
  srcGen: string;  // кто даёт (Родительный)     — "Виталия"
  dstNom: string;  // кому (Именительный)        — "Анандита"
  dstDat: string;  // кому (Дательный)           — "Анандите"
};

const PLANET_RU: Record<Planet,string> = {
  Sun:"Солнце", Moon:"Луна", Mars:"Марс", Mercury:"Меркурий",
  Jupiter:"Юпитер", Venus:"Венера", Saturn:"Сатурн", Rahu:"Раху", Ketu:"Кету"
};

const ORD: Record<number,string> = {
  1:"1-й",2:"2-й",3:"3-й",4:"4-й",5:"5-й",6:"6-й",
  7:"7-й",8:"8-й",9:"9-й",10:"10-й",11:"11-й",12:"12-й"
};

export function normReason(s: string): string {
  const t = s.trim().replace(/\.*$/,"");
  return t.length ? t + "." : "";
}

/** Одна строка: "<Планета> <Gen> даёт <Dat>: <reason> (в N-м доме)" */
export function formatOverlayLine(
  rule: OverlayRule,
  names: NameForms,
  opts?: { includeHouse?: boolean }
): string {
  const planet = PLANET_RU[rule.planet];
  const reason = normReason(rule.reason);
  const houseTail = (opts?.includeHouse ?? true) ? ` (в ${ORD[rule.targetHouse]} доме).` : "";
  const reasonPart = reason ? `: ${reason}` : ":";
  return `${planet} ${names.srcGen} даёт ${names.dstDat}${reasonPart}${houseTail}`;
}

/** Блок из массива правил */
export function formatOverlayBlock(
  title: string,
  rules: OverlayRule[],
  names: NameForms,
  opts?: { includeHouse?: boolean }
): { title: string; lines: string[] } {
  return {
    title,
    lines: rules.map(r => formatOverlayLine(r, names, opts))
  };
}
