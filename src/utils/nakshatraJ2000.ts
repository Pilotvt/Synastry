export const NAKSHATRA_SEGMENT_ARCMIN = 13 * 60 + 20; // 13°20'
export const NAKSHATRA_PADA_ARCMIN = 3 * 60 + 20; // 3°20'
export const NAKSHATRA_GRID_SHIFT_ARCMIN = 20 * 60 + 36; // Δ = 20°36'
export const FULL_CIRCLE_ARCMIN = 360 * 60;

export const NAKSHATRA_NAMES_RU = [
  "Ашвини",
  "Бхарани",
  "Криттика",
  "Рохини",
  "Мригашира",
  "Ардра",
  "Пунарвасу",
  "Пушья",
  "Ашлеша",
  "Магха",
  "Пурвапхалгуни",
  "Уттарапхалгуни",
  "Хаста",
  "Читра",
  "Свати",
  "Вишакха",
  "Анурадха",
  "Джйештха",
  "Мула",
  "Пурваашадха",
  "Уттараашадха",
  "Шравана",
  "Дхаништха",
  "Сатабхиша",
  "Пурвабхадрапада",
  "Уттарабхадрапада",
  "Ревати",
] as const;

export type NakshatraNameRu = (typeof NAKSHATRA_NAMES_RU)[number];

export const NAKSHATRA_LORDS_RU = [
  "Кету",
  "Венера",
  "Солнце",
  "Луна",
  "Марс",
  "Раху",
  "Юпитер",
  "Сатурн",
  "Меркурий",
  "Кету",
  "Венера",
  "Солнце",
  "Луна",
  "Марс",
  "Раху",
  "Юпитер",
  "Сатурн",
  "Меркурий",
  "Кету",
  "Венера",
  "Солнце",
  "Луна",
  "Марс",
  "Раху",
  "Юпитер",
  "Сатурн",
  "Меркурий",
] as const;

export type NakshatraLordRu = (typeof NAKSHATRA_LORDS_RU)[number];

export type NakshatraOriginRu = "Божественная (Дэвата)" | "Человеческая (Манушья)" | "Демоническая (Ракшаса)";
export type NakshatraNatureRu =
  | "Фиксированная (Дхрува)"
  | "Грозная, острая (Тикшна)"
  | "Свирепая, жестокая (Угра)"
  | "Быстрая, светлая (Кшипра)"
  | "Нежная, мягкая (Мриду)"
  | "Нежно-грозная, смешанная (Мриду-Тикшна)"
  | "Временная, подвижная (Чара)";

export const NAKSHATRA_ORIGIN_RU: Record<NakshatraNameRu, NakshatraOriginRu> = {
  Ашвини: "Божественная (Дэвата)",
  Бхарани: "Человеческая (Манушья)",
  Криттика: "Демоническая (Ракшаса)",
  Рохини: "Человеческая (Манушья)",
  Мригашира: "Божественная (Дэвата)",
  Ардра: "Человеческая (Манушья)",
  Пунарвасу: "Божественная (Дэвата)",
  Пушья: "Божественная (Дэвата)",
  Ашлеша: "Демоническая (Ракшаса)",
  Магха: "Демоническая (Ракшаса)",
  Пурвапхалгуни: "Человеческая (Манушья)",
  Уттарапхалгуни: "Человеческая (Манушья)",
  Хаста: "Божественная (Дэвата)",
  Читра: "Демоническая (Ракшаса)",
  Свати: "Божественная (Дэвата)",
  Вишакха: "Демоническая (Ракшаса)",
  Анурадха: "Божественная (Дэвата)",
  Джйештха: "Демоническая (Ракшаса)",
  Мула: "Демоническая (Ракшаса)",
  Пурваашадха: "Человеческая (Манушья)",
  Уттараашадха: "Человеческая (Манушья)",
  Шравана: "Божественная (Дэвата)",
  Дхаништха: "Демоническая (Ракшаса)",
  Сатабхиша: "Демоническая (Ракшаса)",
  Пурвабхадрапада: "Человеческая (Манушья)",
  Уттарабхадрапада: "Человеческая (Манушья)",
  Ревати: "Божественная (Дэвата)",
};

export const NAKSHATRA_NATURE_RU: Record<NakshatraNameRu, NakshatraNatureRu> = {
  Ашвини: "Быстрая, светлая (Кшипра)",
  Бхарани: "Свирепая, жестокая (Угра)",
  Криттика: "Нежно-грозная, смешанная (Мриду-Тикшна)",
  Рохини: "Фиксированная (Дхрува)",
  Мригашира: "Нежная, мягкая (Мриду)",
  Ардра: "Грозная, острая (Тикшна)",
  Пунарвасу: "Временная, подвижная (Чара)",
  Пушья: "Быстрая, светлая (Кшипра)",
  Ашлеша: "Грозная, острая (Тикшна)",
  Магха: "Свирепая, жестокая (Угра)",
  Пурвапхалгуни: "Свирепая, жестокая (Угра)",
  Уттарапхалгуни: "Фиксированная (Дхрува)",
  Хаста: "Быстрая, светлая (Кшипра)",
  Читра: "Нежная, мягкая (Мриду)",
  Свати: "Временная, подвижная (Чара)",
  Вишакха: "Нежно-грозная, смешанная (Мриду-Тикшна)",
  Анурадха: "Нежная, мягкая (Мриду)",
  Джйештха: "Грозная, острая (Тикшна)",
  Мула: "Грозная, острая (Тикшна)",
  Пурваашадха: "Свирепая, жестокая (Угра)",
  Уттараашадха: "Фиксированная (Дхрува)",
  Шравана: "Временная, подвижная (Чара)",
  Дхаништха: "Временная, подвижная (Чара)",
  Сатабхиша: "Временная, подвижная (Чара)",
  Пурвабхадрапада: "Свирепая, жестокая (Угра)",
  Уттарабхадрапада: "Фиксированная (Дхрува)",
  Ревати: "Нежная, мягкая (Мриду)",
};

export type NakshatraJ2000Result = {
  index: number; // 0..26
  name: NakshatraNameRu;
  lord: NakshatraLordRu;
  origin: NakshatraOriginRu;
  nature: NakshatraNatureRu;
  startArcMin: number;
  endArcMin: number;
  posInSegmentArcMin: number; // 0..NAKSHATRA_SEGMENT_ARCMIN
  progress: number; // 0..1
  pada: 1 | 2 | 3 | 4;
  padaStartArcMin: number;
  padaEndArcMin: number;
};

function normArcMin(value: number): number {
  const m = value % FULL_CIRCLE_ARCMIN;
  return m < 0 ? m + FULL_CIRCLE_ARCMIN : m;
}

export function arcMinFromDegrees(degrees: number): number {
  return normArcMin(degrees * 60);
}

export function formatArcMin(valueArcMin: number): string {
  const normalized = normArcMin(valueArcMin);
  const deg = Math.floor(normalized / 60);
  const minutes = Math.floor(normalized - deg * 60);
  return `${deg}\u00B0 ${String(minutes).padStart(2, "0")}'`;
}

export function nakshatraFromLonJ2000(lonDegreesJ2000: number): NakshatraJ2000Result {
  const lonMin = arcMinFromDegrees(lonDegreesJ2000);
  const relMin = normArcMin(lonMin - NAKSHATRA_GRID_SHIFT_ARCMIN);
  const index = Math.max(0, Math.min(26, Math.floor(relMin / NAKSHATRA_SEGMENT_ARCMIN)));
  const name = NAKSHATRA_NAMES_RU[index];
  const lord = NAKSHATRA_LORDS_RU[index];
  const startArcMin = normArcMin(NAKSHATRA_GRID_SHIFT_ARCMIN + index * NAKSHATRA_SEGMENT_ARCMIN);
  const endArcMin = normArcMin(startArcMin + NAKSHATRA_SEGMENT_ARCMIN);

  const posInSegment = relMin - index * NAKSHATRA_SEGMENT_ARCMIN;
  const progress = posInSegment / NAKSHATRA_SEGMENT_ARCMIN;
  const padaIndex = Math.max(0, Math.min(3, Math.floor(posInSegment / NAKSHATRA_PADA_ARCMIN)));
  const pada = (padaIndex + 1) as 1 | 2 | 3 | 4;
  const padaStartArcMin = normArcMin(startArcMin + padaIndex * NAKSHATRA_PADA_ARCMIN);
  const padaEndArcMin = normArcMin(padaStartArcMin + NAKSHATRA_PADA_ARCMIN);

  return {
    index,
    name,
    lord,
    origin: NAKSHATRA_ORIGIN_RU[name],
    nature: NAKSHATRA_NATURE_RU[name],
    startArcMin,
    endArcMin,
    posInSegmentArcMin: posInSegment,
    progress,
    pada,
    padaStartArcMin,
    padaEndArcMin,
  };
}
