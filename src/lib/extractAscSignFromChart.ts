import { SIGN_NAMES_RU } from "../synastry/kuja";

type ChartRecord = Record<string, unknown>;

type HasSign = {
  house?: unknown;
  sign?: unknown;
};

function isRecord(value: unknown): value is ChartRecord {
  return typeof value === "object" && value !== null;
}

function pickAscFromCollection(collection: unknown): string | null {
  if (!Array.isArray(collection)) return null;
  for (const item of collection) {
    if (!isRecord(item)) continue;
    const candidate = item as HasSign;
    const houseNumber = typeof candidate.house === "number" ? candidate.house : Number(candidate.house);
    const signCode = typeof candidate.sign === "string" ? candidate.sign : "";
    if (houseNumber === 1 && signCode) {
      return SIGN_NAMES_RU[signCode as keyof typeof SIGN_NAMES_RU] ?? signCode;
    }
  }
  return null;
}

export function extractAscSignFromChart(chartValue: unknown): string | null {
  if (!isRecord(chartValue)) return null;

  const ascValue = chartValue.ascendant;
  if (isRecord(ascValue) && typeof ascValue.sign === "string") {
    const code = ascValue.sign as keyof typeof SIGN_NAMES_RU;
    return SIGN_NAMES_RU[code] ?? ascValue.sign;
  }

  const fromHouses = pickAscFromCollection(chartValue.houses);
  if (fromHouses) return fromHouses;

  const layout = chartValue.north_indian_layout;
  if (isRecord(layout)) {
    const fromLayout = pickAscFromCollection((layout as ChartRecord).boxes);
    if (fromLayout) return fromLayout;
  }

  return null;
}
