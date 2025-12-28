export type GatakiWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sunday ... 6=Saturday

export type GatakiRuleRow = {
  moonSign: number; // 1..12 (Aries..Pisces)
  gatakaRashi: number; // 1..12
  gatakaTithi: [number, number, number]; // 1..15 (same for both paksha)
  gatakaVara: GatakiWeekday;
  gatakaNakshatraRu: string; // lower-case Russian name
};

// Source: .Лекции/179. Гатаки.doc (table)
export const GATAKI_RULES_RU: Record<number, GatakiRuleRow> = {
  1: { moonSign: 1, gatakaRashi: 1, gatakaTithi: [1, 6, 11], gatakaVara: 0, gatakaNakshatraRu: "магха" },
  2: { moonSign: 2, gatakaRashi: 6, gatakaTithi: [5, 10, 15], gatakaVara: 6, gatakaNakshatraRu: "хаста" },
  3: { moonSign: 3, gatakaRashi: 11, gatakaTithi: [2, 7, 12], gatakaVara: 1, gatakaNakshatraRu: "свати" },
  4: { moonSign: 4, gatakaRashi: 5, gatakaTithi: [2, 7, 12], gatakaVara: 3, gatakaNakshatraRu: "анурадха" },
  5: { moonSign: 5, gatakaRashi: 10, gatakaTithi: [3, 8, 13], gatakaVara: 6, gatakaNakshatraRu: "мула" },
  6: { moonSign: 6, gatakaRashi: 3, gatakaTithi: [5, 10, 15], gatakaVara: 6, gatakaNakshatraRu: "шравана" },
  7: { moonSign: 7, gatakaRashi: 9, gatakaTithi: [4, 9, 14], gatakaVara: 4, gatakaNakshatraRu: "сатабхиша" },
  8: { moonSign: 8, gatakaRashi: 2, gatakaTithi: [1, 6, 11], gatakaVara: 5, gatakaNakshatraRu: "ревати" },
  9: { moonSign: 9, gatakaRashi: 12, gatakaTithi: [3, 8, 13], gatakaVara: 5, gatakaNakshatraRu: "бхарани" },
  10: { moonSign: 10, gatakaRashi: 5, gatakaTithi: [4, 9, 14], gatakaVara: 4, gatakaNakshatraRu: "рохини" },
  11: { moonSign: 11, gatakaRashi: 9, gatakaTithi: [3, 8, 13], gatakaVara: 2, gatakaNakshatraRu: "ардра" },
  12: { moonSign: 12, gatakaRashi: 11, gatakaTithi: [5, 10, 15], gatakaVara: 5, gatakaNakshatraRu: "ашлеша" },
} as const;
