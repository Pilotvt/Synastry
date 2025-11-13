export function scoreFromText(desc: string): { score: number; tier: string } {
  const s = (desc || "").toLowerCase();
  const pick = (score:number, tier:string)=>({score, tier});

  // 1) Сначала обрабатываем явные негативы и отрицания, иначе "не очень хорошее" ложно сработает как "очень хорошее"
    if (/не\s+очень\s+хорош/.test(s))            return pick(58, "средне");
    if (/не\s+.*хорош/.test(s))                   return pick(60, "средне");
    if (/(плох|тяжел|сложно|конфликт|разрыв)/.test(s)) return pick(48, "сложно");
    if (/(неустойчив|охлажден|проблем)/.test(s))   return pick(55, "средне");

  // 2) Позитивные градации
  if (/идеальн/.test(s))                     return pick(94, "идеально");
  if (/очень\s+хорош|очень\s+удач/.test(s)) return pick(86, "очень хорошо");
  if (/удачн|уравновешенн|прочн|стабильн/.test(s)) return pick(78, "хорошо");
  if (/(всё|все)\s+хорошо/.test(s))          return pick(76, "хорошо");
  if (/яркое|динамич|драйв/.test(s))         return pick(74, "хорошо");

  // 3) Нейтрально-средние
  if (/взрывн|нестабил/.test(s))             return pick(60, "средне");
  if (/средне|нейтраль/.test(s))             return pick(65, "средне");

  // 4) По умолчанию — средне
  return pick(65, "средне");
}
