const COUNTRY_RU_OVERRIDES: Record<string, string> = {
  RU: "Россия",
  UA: "Украина",
  BY: "Беларусь",
  KZ: "Казахстан",
  US: "США",
  AE: "ОАЭ",
  CN: "Китай",
  IN: "Индия",
  GB: "Великобритания",
  DE: "Германия",
  FR: "Франция",
  IT: "Италия",
  ES: "Испания",
  PT: "Португалия",
  PL: "Польша",
  TR: "Турция",
  CA: "Канада",
};

const regionNames =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["ru"], { type: "region" })
    : null;

export function countryNameRU(code: string): string {
  const normalized = String(code || "").toUpperCase();
  if (!normalized) return "-";
  if (!/^[A-Z]{2,3}$/.test(normalized)) return normalized;
  const override = COUNTRY_RU_OVERRIDES[normalized];
  if (override) return override;
  try {
    return regionNames?.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}
