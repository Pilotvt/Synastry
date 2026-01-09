type ForeignCityRuMap = Record<string, string>;

let foreignCitiesCache: ForeignCityRuMap | null = null;
let foreignCitiesPromise: Promise<ForeignCityRuMap> | null = null;

function publicAssetUrl(relativePath: string) {
  if (typeof window === "undefined") return relativePath;
  try {
    return new URL(relativePath, window.location.href).toString();
  } catch {
    return relativePath;
  }
}

function formatCoord(value: number): string {
  const rounded = Math.round(value * 1e5) / 1e5;
  return rounded.toFixed(5);
}

export function buildForeignCityKey(country: string, name: string, lat: number, lon: number): string {
  const code = String(country || "").trim().toUpperCase();
  const cityName = String(name || "").trim();
  return `${code}|${cityName}|${formatCoord(lat)}|${formatCoord(lon)}`;
}

export function lookupForeignCityRuName(
  map: ForeignCityRuMap | null | undefined,
  params: { country: string; name: string; lat: number; lon: number },
): string | undefined {
  if (!map) return undefined;
  if (!Number.isFinite(params.lat) || !Number.isFinite(params.lon)) return undefined;
  const key = buildForeignCityKey(params.country, params.name, params.lat, params.lon);
  return map[key];
}

export async function getForeignCitiesRuMap(): Promise<ForeignCityRuMap> {
  if (foreignCitiesCache) return foreignCitiesCache;
  if (!foreignCitiesPromise) {
    foreignCitiesPromise = fetch(publicAssetUrl("cities-ru/foreign-cities-ru.json"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load foreign cities ru map: HTTP ${response.status}`);
        }
        const data = await response.json();
        const normalized: ForeignCityRuMap = data && typeof data === "object" ? (data as ForeignCityRuMap) : {};
        foreignCitiesCache = normalized;
        return normalized;
      })
      .catch((error) => {
        foreignCitiesPromise = null;
        throw error;
      });
  }
  return foreignCitiesPromise;
}

export type { ForeignCityRuMap };
