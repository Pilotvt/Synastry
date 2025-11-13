// synastry-compat.ts
// Utility to load and lookup compatibility descriptions for ascendant sign pairs
import compatibilityData from "../../data/совместимость_144_ru_full.json";

export type CompatibilityMapV1 = Record<string, Record<string, { описание: string }[]>>; // nested map
export type CompatibilityMapV2 = Record<string, Array<{ "сочетание с": string; описание: string }>>; // array per sign

// Returns description for (asc1, asc2) pair, e.g. ('Овен', 'Телец')
export function getAscCompatibility(asc1: string, asc2: string): string | null {
  const raw = (compatibilityData["совместимость по восходящему знаку"] ?? {}) as unknown;
  if (!raw || typeof raw !== 'object') return null;

  // Shape V2: { "Овен": [ { "сочетание с": "Телец", "описание": "..." }, ... ] }
  const mapV2 = raw as CompatibilityMapV2;
  if (Array.isArray(mapV2[asc1] as any)) {
    const list = mapV2[asc1] as Array<{ "сочетание с": string; описание: string }>;
    const item = list.find((it) => typeof it?.["сочетание с"] === 'string' && it["сочетание с"].trim() === asc2);
    return item?.описание ?? null;
  }

  // Shape V1: { "Овен": { "Телец": [ { описание: "..." } ] } }
  const mapV1 = raw as unknown as CompatibilityMapV1;
  const group = (mapV1 as any)[asc1];
  if (group && typeof group === 'object' && Array.isArray(group[asc2])) {
    const entry = group[asc2][0];
    return entry?.описание ?? null;
  }

  return null;
}
