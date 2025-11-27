type RussianCityRecord = {
  name: string;
  lat: number;
  lon: number;
  subject?: string;
  population?: number;
};

let russianCitiesCache: RussianCityRecord[] | null = null;
let russianCitiesPromise: Promise<RussianCityRecord[]> | null = null;

function publicAssetUrl(relativePath: string) {
  if (typeof window === "undefined") return relativePath;
  try {
    return new URL(relativePath, window.location.href).toString();
  } catch {
    return relativePath;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function normalizeRussianCity(raw: unknown): RussianCityRecord | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const coords = isRecord(raw.coords) ? raw.coords : undefined;
  const latRaw = coords?.lat ?? raw.lat ?? raw.latitude;
  const lonRaw = coords?.lon ?? raw.lon ?? raw.longitude;
  const lat = typeof latRaw === "number" ? latRaw : parseFloat(String(latRaw ?? ""));
  const lon = typeof lonRaw === "number" ? lonRaw : parseFloat(String(lonRaw ?? ""));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    name,
    lat,
    lon,
    subject: typeof raw.subject === "string" ? raw.subject : undefined,
    population: typeof raw.population === "number" ? raw.population : undefined,
  };
}

export async function getRussianCities(): Promise<RussianCityRecord[]> {
  if (russianCitiesCache) return russianCitiesCache;
  if (!russianCitiesPromise) {
    russianCitiesPromise = fetch(publicAssetUrl("cities-ru/russian-cities.json"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load russian cities: HTTP ${response.status}`);
        }
        const data = await response.json();
        const normalized = Array.isArray(data)
          ? data
              .map(normalizeRussianCity)
              .filter((item): item is RussianCityRecord => Boolean(item))
          : [];
        russianCitiesCache = normalized;
        return normalized;
      })
      .catch((error) => {
        russianCitiesPromise = null;
        throw error;
      });
  }
  return russianCitiesPromise;
}

export function findNearestRussianCity(
  lat: number,
  lon: number,
  cities: RussianCityRecord[],
  maxScore = 0.25,
): RussianCityRecord | null {
  if (!cities || cities.length === 0) return null;
  let best: RussianCityRecord | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const city of cities) {
    const dLat = lat - city.lat;
    const dLon = lon - city.lon;
    const score = Math.abs(dLat) + Math.abs(dLon);
    if (score < bestScore) {
      best = city;
      bestScore = score;
    }
  }
  if (best && bestScore <= maxScore) {
    return best;
  }
  return null;
}

export type { RussianCityRecord as RussianCity };
