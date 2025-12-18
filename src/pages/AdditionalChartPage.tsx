// Локальная страница «Дополнительно»: без облака и анкеты, только расчёт и сохранение в файл.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import moment from "moment-timezone";
import tzLookup from "tz-lookup";
import { supabase } from "../lib/supabase";
import NorthIndianChart from "../components/NorthIndianChart";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";
import { getRussianCities } from "../utils/russianCitiesClient";
import { requestNewChartReset } from "../utils/newChartRequest";
import { norm, latinToRuName, ruToLat } from "../utils/transliterate";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";
const DEBOUNCE_MS = 300;

const COUNTRY_RU_NAMES: Record<string, string> = {
  RU: "Россия",
  UA: "Украина",
  BY: "Беларусь",
  KZ: "Казахстан",
  US: "США",
  CA: "Канада",
  GB: "Великобритания",
  DE: "Германия",
  FR: "Франция",
  IT: "Италия",
  ES: "Испания",
  PT: "Португалия",
  PL: "Польша",
  TR: "Турция",
  CN: "Китай",
  IN: "Индия",
};

function countryNameRU(code: string) {
  const upper = (code || "").toUpperCase();
  return COUNTRY_RU_NAMES[upper] || upper;
}

function publicAssetUrl(relativePath: string) {
  if (typeof window === "undefined") return relativePath;
  try {
    return new URL(relativePath, window.location.href).toString();
  } catch (error) {
    console.warn("Failed to resolve asset URL", relativePath, error);
    return relativePath;
  }
}

type CitiesIndexFile = {
  countries: Array<{ country: string; count: number }>;
};

type CityJsonItem = {
  name: string;
  country: string;
  lat: number;
  lon: number;
  geonameid?: string | number;
  nameRu?: string;
  name_ru?: string;
};

type CitySuggestion = {
  id: string;
  name: string;
  nameRu: string;
  lat: number;
  lon: number;
  country: string;
  nameNorm: string;
  nameRuNorm: string;
  nameTranslit: string;
};

function makeCitySuggestion(source: {
  id?: string;
  name: string;
  nameRu?: string;
  country: string;
  lat: number;
  lon: number;
}): CitySuggestion {
  const country = (source.country || "").toUpperCase();
  const name = String(source.name || "").trim();
  const nameRu = String(source.nameRu || source.name || "").trim();
  const id = source.id ? String(source.id) : `${country}:${name}:${source.lat}:${source.lon}`;
  const nameNorm = norm(name);
  const nameRuNorm = norm(nameRu);
  const nameTranslit = norm(ruToLat(nameRu));
  return { id, name, nameRu, lat: source.lat, lon: source.lon, country, nameNorm, nameRuNorm, nameTranslit };
}

type ChartRequestPayload = {
  datetime_iso: string;
  latitude: number;
  longitude: number;
  elevation_m: number;
  house_system: string;
};

type AspectLabel = {
  planet: string;
  from_house: number;
  to_house: number;
  houses_away: number;
  label: string;
};

type NorthIndianBox = {
  sign: string;
  house: number;
  bodies: string[];
  aspects?: AspectLabel[];
};

type ChartResponse = {
  ascendant: { sign: string; degree: number; lon_sidereal: number };
  mc: { sign: string; degree: number; lon_sidereal: number };
  planets: {
    name: string;
    lon_sidereal: number;
    sign: string;
    house: number;
    nakshatra?: string | null;
    iau_constellation: string;
    is_retrograde: boolean;
    sidereal_speed?: number;
    house_progress?: number;
    house_strength?: number;
  }[];
  houses: { house: number; sign: string }[];
  north_indian_layout: { boxes: NorthIndianBox[] };
  aspects?: AspectLabel[];
  constellation_arcs: {
    iau_code: string;
    iau_name_ru: string;
    lon_start_deg: number;
    lon_end_deg: number;
  }[];
  planet_constellations: {
    body: string;
    iau_code: string;
    iau_name_ru: string;
    ra_deg_b1875: number;
    dec_deg_b1875: number;
  }[];
};

type BuildMeta = {
  ianaTz: string;
  datetimeIso: string;
  baseOffsetMinutes: number;
  finalOffsetMinutes: number;
  autoDstMinutes: number;
  manualDstMinutes: number;
  tzCorrectionMinutes: number;
};

type ChartVariant = "rashi" | "chandra" | "surya";

const CHART_VARIANT_OPTIONS: Array<{ value: ChartVariant; title: string; subtitle: string }> = [
  { value: "rashi", title: "Rashi", subtitle: "Карта восходящего знака" },
  { value: "chandra", title: "Chandra", subtitle: "Лунная карта" },
  { value: "surya", title: "Surya", subtitle: "Солнечная карта" },
];

const CHART_VARIANT_CONFIG: Record<
  ChartVariant,
  {
    chartTitle: string;
    headerAscLabel: string;
    longitudeLabel: string | null;
    description: string;
  }
> = {
  rashi: {
    chartTitle: "КАРТА ВОСХОДЯЩЕГО ЗНАКА (RASHI)",
    headerAscLabel: "Восходящий знак",
    longitudeLabel: null,
    description: "Базовая натальная карта. Асцендент определяет первый дом, все дома и описания рассчитываются относительно него.",
  },
  chandra: {
    chartTitle: "ЛУННАЯ КАРТА (CHANDRA)",
    headerAscLabel: "Созвездие 1 дома (Луна)",
    longitudeLabel: "Луна",
    description: "Лунная карта. Первый дом — знак Луны, дома и трактовки пересчитаны относительно Луны.",
  },
  surya: {
    chartTitle: "СОЛНЕЧНАЯ КАРТА (SURYA)",
    headerAscLabel: "Созвездие 1 дома (Солнце)",
    longitudeLabel: "Солнце",
    description: "Солнечная карта. Первый дом — знак Солнца, дома и трактовки пересчитаны относительно Солнца.",
  },
};

const SIGN_INFO: Record<string, { index: number; ru: string; en: string }> = {
  Ar: { index: 1, ru: "Овен", en: "Aries" },
  Ta: { index: 2, ru: "Телец", en: "Taurus" },
  Ge: { index: 3, ru: "Близнецы", en: "Gemini" },
  Cn: { index: 4, ru: "Рак", en: "Cancer" },
  Le: { index: 5, ru: "Лев", en: "Leo" },
  Vi: { index: 6, ru: "Дева", en: "Virgo" },
  Li: { index: 7, ru: "Весы", en: "Libra" },
  Sc: { index: 8, ru: "Скорпион", en: "Scorpio" },
  Sg: { index: 9, ru: "Стрелец", en: "Sagittarius" },
  Cp: { index: 10, ru: "Козерог", en: "Capricorn" },
  Aq: { index: 11, ru: "Водолей", en: "Aquarius" },
  Pi: { index: 12, ru: "Рыбы", en: "Pisces" },
};

function rotateHouseNumber(house: number | null | undefined, shift: number): number | null {
  if (typeof house !== "number" || !Number.isFinite(house)) return null;
  const normalized = ((house - 1 - shift) % 12 + 12) % 12;
  return normalized + 1;
}

type ProfileSnapshot = {
  personName: string;
  lastName: string;
  birth: string;
  gender: "male" | "female";
  country: string;
  cityQuery: string;
  selectedCity?: string;
  cityNameRu?: string;
  lat: number;
  lon: number;
  enableTzCorrection: boolean;
  tzCorrectionHours: number;
  dstManual: boolean;
};

type BirthParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const defaultBirthParts: BirthParts = { year: 1990, month: 1, day: 1, hour: 12, minute: 0 };

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  if (mins === 0) return `UTC${sign}${hours}`;
  return `UTC${sign}${hours}:${mins.toString().padStart(2, "0")}`;
}

function normalizeParts(parts: BirthParts): BirthParts {
  const date = moment
    .utc()
    .year(parts.year || 1990)
    .month(Math.max(0, Math.min(11, (parts.month || 1) - 1)))
    .date(Math.max(1, parts.day || 1))
    .hour(Math.max(0, parts.hour || 0))
    .minute(Math.max(0, parts.minute || 0))
    .second(0)
    .millisecond(0);
  return {
    year: date.year(),
    month: date.month() + 1,
    day: date.date(),
    hour: date.hour(),
    minute: date.minute(),
  };
}

function formatLocalTime(parts: BirthParts, tz: string): string {
  try {
    const local = moment.tz(`${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`, tz);
    return `${local.format("YYYY-MM-DD; THH:mm")} (${tz}, ${formatOffset(local.utcOffset())})`;
  } catch {
    return "-";
  }
}

const PLANET_NAMES_RU: Record<string, string> = {
  Su: "Солнце",
  Mo: "Луна",
  Me: "Меркурий",
  Ve: "Венера",
  Ma: "Марс",
  Ju: "Юпитер",
  Sa: "Сатурн",
  Ra: "Раху",
  Ke: "Кету",
};

function degStr(value: number): string {
  const normDeg = ((value % 360) + 360) % 360;
  const d = Math.floor(normDeg);
  const m = Math.floor((normDeg - d) * 60);
  return `${d}\u00b0 ${m.toString().padStart(2, "0")}'`;
}

function normalizeCityQuery(value: string): string {
  return norm(value || "");
}

function matchPrefix(query: string, city: CitySuggestion): boolean {
  const q = normalizeCityQuery(query);
  if (!q) return true;
  if (city.nameRuNorm.startsWith(q) || city.nameNorm.startsWith(q) || city.nameTranslit.startsWith(q)) {
    return true;
  }
  const alt = normalizeCityQuery(latinToRuName(city.name));
  return alt.startsWith(q);
}

const AdditionalChartPage: React.FC = () => {
  const navigate = useNavigate();
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [meta, setMeta] = useState<BuildMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [personName, setPersonName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [country, setCountry] = useState("RU");
  const [countryOptions, setCountryOptions] = useState<string[]>(["RU"]);
  const [cityQuery, setCityQuery] = useState("Омск");
  const [selectedCity, setSelectedCity] = useState<CitySuggestion | null>(null);
  const [cities, setCities] = useState<CitySuggestion[]>([]);
  const cityCacheRef = useRef<Map<string, CitySuggestion[]>>(new Map());
  const [birthParts, setBirthParts] = useState<BirthParts>(defaultBirthParts);
  const [lat, setLat] = useState(54.84152);
  const [lon, setLon] = useState(73.30174);
  const [ianaTz, setIanaTz] = useState<string>("Asia/Omsk");
  const [enableTzCorrection, setEnableTzCorrection] = useState(false);
  const [tzCorrectionHours, setTzCorrectionHours] = useState(0);
  const [dstManual, setDstManual] = useState(false);
  const [autoDst, setAutoDst] = useState(false);
  const [autoApplyCity, setAutoApplyCity] = useState(true);
  const [chartVariant, setChartVariant] = useState<ChartVariant>("rashi");
  const [debounceTimer, setDebounceTimer] = useState<number | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const blurTimerRef = useRef<number | null>(null);

  const suggestions = useMemo(() => {
    if (!cityQuery) return cities.slice(0, 20);
    const filtered = cities.filter((c) => matchPrefix(cityQuery, c));
    return filtered.slice(0, 20);
  }, [cities, cityQuery]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(publicAssetUrl("cities-by-country/index.json"), { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as CitiesIndexFile;
        const codes = Array.isArray(json?.countries)
          ? json.countries.map((entry) => String(entry.country || "").toUpperCase()).filter(Boolean)
          : [];
        if (!codes.includes("RU")) codes.push("RU");
        codes.sort((a, b) => countryNameRU(a).localeCompare(countryNameRU(b), "ru"));
        if (!cancelled) setCountryOptions(codes);
      } catch (error) {
        console.warn("Failed to load countries index for AdditionalChartPage", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const code = (country || "RU").toUpperCase();
    const cached = cityCacheRef.current.get(code);
    if (cached) {
      setCities(cached);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        let list: CitySuggestion[] = [];
        if (code === "RU") {
          const ru = await getRussianCities();
          list = ru.map((c) =>
            makeCitySuggestion({
              id: `RU:${c.name}:${c.lat}:${c.lon}`,
              name: c.name,
              nameRu: c.name,
              country: "RU",
              lat: c.lat,
              lon: c.lon,
            }),
          );
        } else {
          const response = await fetch(publicAssetUrl(`cities-by-country/${code}.json`), { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as unknown;
          if (Array.isArray(data)) {
            list = data
              .map((item): CitySuggestion | null => {
                const raw = item as Partial<CityJsonItem>;
                const name = typeof raw.name === "string" ? raw.name.trim() : "";
                const country = typeof raw.country === "string" ? raw.country.toUpperCase() : code;
                const lat = typeof raw.lat === "number" ? raw.lat : Number(raw.lat);
                const lon = typeof raw.lon === "number" ? raw.lon : Number(raw.lon);
                if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
                const id = raw.geonameid !== undefined ? String(raw.geonameid) : `${country}:${name}:${lat}:${lon}`;
                const nameRu = (typeof raw.nameRu === "string" && raw.nameRu.trim())
                  ? raw.nameRu.trim()
                  : (typeof raw.name_ru === "string" && raw.name_ru.trim())
                    ? raw.name_ru.trim()
                    : name;
                return makeCitySuggestion({ id, name, nameRu, country, lat, lon });
              })
              .filter((c): c is CitySuggestion => Boolean(c));
          }
        }
        cityCacheRef.current.set(code, list);
        if (!cancelled) setCities(list);
      } catch (error) {
        console.warn(`Failed to load cities for country ${code}`, error);
        if (!cancelled) setCities([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [country]);

  useEffect(() => {
    try {
      const tz = tzLookup(lat, lon);
      setIanaTz(tz);
    } catch (err) {
      console.warn("tzLookup failed", err);
    }
  }, [lat, lon]);

  const recomputeMeta = useCallback(
    (parts: BirthParts): BuildMeta | null => {
      try {
        const local = moment.tz(
          `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`,
          ianaTz,
        );
        if (!local.isValid()) return null;

        const baseOffsetMinutes = local.utcOffset();
        const autoDstMinutes = local.isDST() ? 60 : 0;
        const tzCorrectionMinutes = enableTzCorrection ? (Number.isFinite(tzCorrectionHours) ? tzCorrectionHours * 60 : 0) : 0;
        const manualDstMinutes = enableTzCorrection ? (dstManual ? 60 : 0) : 0;
        const finalOffsetMinutes =
          baseOffsetMinutes
          + (enableTzCorrection ? tzCorrectionMinutes + (manualDstMinutes - autoDstMinutes) : 0);

        // Shift the instant by delta minutes so the final UTC becomes correct for the requested correction.
        const deltaMinutes = finalOffsetMinutes - baseOffsetMinutes;
        const adjusted = local.clone().add(deltaMinutes, "minutes");
        const datetimeIso = adjusted.format("YYYY-MM-DDTHH:mm:ssZ");

        setAutoDst(autoDstMinutes > 0);
        return {
          ianaTz,
          datetimeIso,
          baseOffsetMinutes,
          finalOffsetMinutes,
          autoDstMinutes,
          manualDstMinutes,
          tzCorrectionMinutes: enableTzCorrection ? tzCorrectionMinutes : 0,
        };
      } catch (err) {
        console.warn("Failed to build meta", err);
        return null;
      }
    },
    [ianaTz, enableTzCorrection, tzCorrectionHours, dstManual],
  );

  const buildProfileSnapshot = useCallback(
    (parts: BirthParts): ProfileSnapshot => ({
      personName,
      lastName,
      birth: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`,
      gender,
      country,
      cityQuery,
      selectedCity: selectedCity?.name,
      cityNameRu: selectedCity?.nameRu,
      lat,
      lon,
      enableTzCorrection,
      tzCorrectionHours,
      dstManual: enableTzCorrection ? dstManual : false,
    }),
    [personName, lastName, gender, country, cityQuery, selectedCity, lat, lon, enableTzCorrection, tzCorrectionHours, dstManual],
  );

  const buildChart = useCallback(
    async (parts: BirthParts) => {
      const metaPayload = recomputeMeta(parts);
      if (!metaPayload) return;
      const payload: ChartRequestPayload = {
        datetime_iso: metaPayload.datetimeIso,
        latitude: lat,
        longitude: lon,
        elevation_m: 0,
        house_system: "W",
      };
      setLoading(true);
      setError(null);
      try {
        const endpoint = `${API_BASE_URL.replace(/\/$/, "")}/api/chart`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Ошибка сервера: ${res.status} ${txt}`);
        }
        const json = (await res.json()) as ChartResponse;
        setChart(json);
        setMeta(metaPayload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setChart(null);
      } finally {
        setLoading(false);
      }
    },
    [lat, lon, recomputeMeta],
  );

  const scheduleRebuild = useCallback(
    (nextParts: BirthParts) => {
      setBirthParts(nextParts);
      if (debounceTimer) clearTimeout(debounceTimer);
      const handle = window.setTimeout(() => void buildChart(nextParts), DEBOUNCE_MS);
      setDebounceTimer(handle);
    },
    [buildChart, debounceTimer],
  );

  useEffect(() => {
    void buildChart(birthParts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [debounceTimer],
  );

  const handlePartChange = (field: keyof BirthParts, value: number) => {
    const next = normalizeParts({ ...birthParts, [field]: value });
    scheduleRebuild(next);
  };

  const handleCitySelect = (city: CitySuggestion) => {
    setSelectedCity(city);
    setCityQuery(city.nameRu || city.name);
    setLat(city.lat);
    setLon(city.lon);
    try {
      const tz = tzLookup(city.lat, city.lon);
      setIanaTz(tz);
    } catch (err) {
      console.warn("tzLookup failed for selected city", err);
    }
    setAutoApplyCity(false);
    setSuggestionsOpen(false);
    scheduleRebuild(normalizeParts(birthParts));
  };

  const handleCityInput = (value: string) => {
    setCityQuery(value);
    setSelectedCity(null);
    setAutoApplyCity(true);
    setSuggestionsOpen(true);
  };

  useEffect(() => {
    if (!autoApplyCity || !cityQuery) return;
    const query = normalizeCityQuery(cityQuery);
    const exact = cities.find((c) => c.nameRuNorm === query || c.nameNorm === query);
    if (exact) handleCitySelect(exact);
  }, [autoApplyCity, cityQuery, cities]);

  const utcString = useMemo(() => {
    if (!meta) return "";
    const effectiveDst = enableTzCorrection ? meta.manualDstMinutes > 0 : meta.autoDstMinutes > 0;
    const dstLabel = effectiveDst ? "(DST)" : "(без DST)";
    return `На момент рождения: ${formatOffset(meta.finalOffsetMinutes)} ${dstLabel}`;
  }, [enableTzCorrection, meta]);

  const handleSaveToFile = async () => {
    if (!chart || !meta) return;
    const profile = buildProfileSnapshot(birthParts);
    const payload = { chart, meta, profile, updated_at: Date.now() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "synastry_additional_chart.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  const chartVariantConfig = CHART_VARIANT_CONFIG[chartVariant];

  const sunPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Su") ?? null, [chart]);
  const moonPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Mo") ?? null, [chart]);

  const variantShift = useMemo(() => {
    const sunBaseHouse = sunPlanet?.house ?? null;
    const moonBaseHouse = moonPlanet?.house ?? null;
    if (chartVariant === "chandra" && typeof moonBaseHouse === "number") {
      return (moonBaseHouse - 1 + 12) % 12;
    }
    if (chartVariant === "surya" && typeof sunBaseHouse === "number") {
      return (sunBaseHouse - 1 + 12) % 12;
    }
    return 0;
  }, [chartVariant, moonPlanet?.house, sunPlanet?.house]);

  const houses = useMemo(() => {
    if (!chart) return [];
    const boxes = Array.isArray(chart.north_indian_layout?.boxes) ? chart.north_indian_layout.boxes : [];
    const retroMap = new Map<string, boolean>();
    if (Array.isArray(chart.planets)) {
      chart.planets.forEach((planet) => retroMap.set(planet.name, !!planet.is_retrograde));
    }
    const rotated = boxes.map((box) => {
      const rotatedHouse = rotateHouseNumber(box.house ?? null, variantShift) ?? box.house ?? 0;
      const signInfo = SIGN_INFO[box.sign] ?? { index: 0, ru: box.sign, en: box.sign };
      const planetLabels = Array.isArray(box.bodies)
        ? box.bodies.map((code) => (retroMap.get(code) ? `${code} R` : code))
        : [];
      const aspectLabels = Array.isArray(box.aspects) ? box.aspects.map((a) => a.label) : [];
      return {
        houseNumber: rotatedHouse,
        sign: box.sign,
        signIndex: signInfo.index || null,
        signLabel: signInfo.ru,
        planetLabels,
        aspectLabels,
      };
    });
    rotated.sort((a, b) => a.houseNumber - b.houseNumber);
    return rotated;
  }, [chart, variantShift]);

  const planetTable = useMemo(() => {
    if (!chart) return null;
    return (
      <div style={{ maxWidth: "1100px", width: "100%", marginTop: 16 }}>
        <div style={{ fontWeight: 900, textTransform: "uppercase", marginBottom: 6 }}>
          СОЗВЕЗДИЯ И ПЛАНЕТЫ (
          <span style={{ fontWeight: 600 }}>
            {"\u2191-уча, \u2193-нича, \u25cb-карака, \u25a1-дигбала, \u25c7-свой знак, \u25cf-сожжёная, \u00d8-проигравшая, \u2600-супер сильная"}
          </span>
          )
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", background: "#f2e3c2", border: "1px solid #b38b52" }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #b38b52", padding: "4px" }}>Планета</th>
              <th style={{ border: "1px solid #b38b52", padding: "4px" }}>Дом</th>
              <th style={{ border: "1px solid #b38b52", padding: "4px" }}>Знак</th>
              <th style={{ border: "1px solid #b38b52", padding: "4px" }}>Созвездие</th>
              <th style={{ border: "1px solid #b38b52", padding: "4px" }}>Долгота</th>
              <th style={{ border: "1px solid #b38b52", padding: "4px" }}>Ретро</th>
            </tr>
          </thead>
          <tbody>
            {chart.planets.map((p) => {
              const rotatedHouse = rotateHouseNumber(p.house ?? null, variantShift) ?? p.house;
              const signRu = SIGN_INFO[p.sign]?.ru ?? p.sign;
              return (
	              <tr key={p.name}>
	                <td style={{ border: "1px solid #b38b52", padding: "4px" }}>{PLANET_NAMES_RU[p.name] ?? p.name}</td>
	                <td style={{ border: "1px solid #b38b52", padding: "4px", textAlign: "center" }}>{rotatedHouse}</td>
	                <td style={{ border: "1px solid #b38b52", padding: "4px", textAlign: "center" }}>{signRu}</td>
	                <td style={{ border: "1px solid #b38b52", padding: "4px" }}>{p.iau_constellation}</td>
	                <td style={{ border: "1px solid #b38b52", padding: "4px" }}>{degStr(p.lon_sidereal)}</td>
	                <td style={{ border: "1px solid #b38b52", padding: "4px", textAlign: "center" }}>{p.is_retrograde ? "R" : ""}</td>
	              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [chart, variantShift]);

  const headerLines = useMemo(() => {
    const cityLabel = selectedCity?.nameRu || selectedCity?.name || cityQuery || "—";
    const coordsLabel = Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : "";
    const localTime = meta
      ? `${birthParts.year}-${pad2(birthParts.month)}-${pad2(birthParts.day)}; T${pad2(birthParts.hour)}:${pad2(birthParts.minute)} (${ianaTz}, ${formatOffset(meta.finalOffsetMinutes)})`
      : formatLocalTime(birthParts, ianaTz);

    const firstHouseBox = houses.find((house) => house.houseNumber === 1);
    const ascSignCode = firstHouseBox?.sign ?? chart?.ascendant?.sign ?? "";
    const ascSignName = SIGN_INFO[ascSignCode]?.ru ?? ascSignCode;
    const ascLongitudeValue =
      chartVariant === "chandra"
        ? moonPlanet?.lon_sidereal ?? null
        : chartVariant === "surya"
          ? sunPlanet?.lon_sidereal ?? null
          : chart?.ascendant?.lon_sidereal ?? null;
    const ascLongitudeText = typeof ascLongitudeValue === "number" && Number.isFinite(ascLongitudeValue) ? degStr(ascLongitudeValue) : "";
    const ascLine = `${chartVariantConfig.headerAscLabel}: ${ascSignName}${ascLongitudeText ? ` - ${ascLongitudeText}` : ""}`;
    const mcLongitudeText = typeof chart?.mc?.lon_sidereal === "number" && Number.isFinite(chart.mc.lon_sidereal) ? degStr(chart.mc.lon_sidereal) : "";
    const mcLine = mcLongitudeText ? `MC: ${mcLongitudeText}` : "MC: —";

    return {
      cityLine: `Город: ${cityLabel}${coordsLabel ? ` · ${coordsLabel}` : ""}`,
      localTimeLine: `Локальное время: ${localTime}`,
      ascLine,
      mcLine,
    };
  }, [
    birthParts,
    chart,
    chartVariant,
    chartVariantConfig.headerAscLabel,
    cityQuery,
    houses,
    ianaTz,
    lat,
    lon,
    meta,
    moonPlanet?.lon_sidereal,
    selectedCity?.name,
    selectedCity?.nameRu,
    sunPlanet?.lon_sidereal,
  ]);

  return (
    <div className="additional-page min-h-screen bg-[#f5e4c3] text-[#2b1c0f]">
      <style>{`
        .additional-page .north-indian-chart-title {
          color: #2b1c0f !important;
          font-weight: 400 !important;
          margin-bottom: 12px !important; /* match mb-3 */
        }
        .additional-page .birth-panel-title {
          text-align: center;
          font-size: 16px;
          font-weight: 400;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 12px;
        }
        .additional-page input[type="number"]::-webkit-outer-spin-button,
        .additional-page input[type="number"]::-webkit-inner-spin-button {
          opacity: 1;
          -webkit-appearance: inner-spin-button;
        }
      `}</style>
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-wrap gap-2 mb-4 justify-end">
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1`}
            onClick={() => requestNewChartReset("additional")}
          >
            Новая карта
          </button>
          <button type="button" className={`${BUTTON_SECONDARY} px-3 py-1`} onClick={() => navigate("/chart")}>
            Натальная карта
          </button>
          <button type="button" className={`${BUTTON_SECONDARY} px-3 py-1`} onClick={() => navigate("/questionnaire")}>
            Изменить анкету
          </button>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1`}
            onClick={async () => {
              const { data: sessionData } = await supabase.auth.getSession();
              const userId = sessionData?.session?.user?.id;
              if (userId) {
                navigate(`/user/${userId}`);
              } else {
                navigate("/auth");
              }
            }}
          >
            Профиль
          </button>
          <button type="button" className={`${BUTTON_SECONDARY} px-3 py-1`} onClick={() => navigate("/sinastry")}>
            Синастрия
          </button>
          <button type="button" className={`${BUTTON_PRIMARY} px-3 py-1 cursor-default`} disabled>
            Дополнительно
          </button>
        </div>

        <div className="mb-2">
          <h1 className="text-3xl font-bold text-[#2b1c0f]">Натальная карта</h1>
          <div className="text-sm text-[#2b1c0f] leading-5 mt-1">
            {personName || lastName ? (
              <div>
                {personName} {lastName}
              </div>
            ) : null}
            <div>Пол: {gender === "male" ? "мужской" : "женский"}</div>
            <div>{headerLines.cityLine}</div>
            <div>{headerLines.localTimeLine}</div>
            <div>{headerLines.ascLine}</div>
            <div>{headerLines.mcLine}</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-2 justify-start items-start">
          {CHART_VARIANT_OPTIONS.map((option) => {
            const isActive = option.value === chartVariant;
            const baseClasses = "px-3 py-2 text-left min-w-[160px] leading-tight border border-[#7a643a] bg-[#f7e4c1] text-black transition-colors";
            const stateClasses = isActive ? "bg-[#e8d7b0] text-[#9a8046] cursor-default" : "hover:bg-[#edd7aa]";
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setChartVariant(option.value)}
                className={`${baseClasses} ${stateClasses}`}
                aria-pressed={isActive}
              >
                <div className="text-sm font-semibold">{option.title}</div>
                <div className="text-xs text-black/60">{option.subtitle}</div>
              </button>
            );
          })}
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            onClick={handleSaveToFile}
            disabled={!chart || !meta}
          >
            Сохранить в файл
          </button>
        </div>
        <div style={{ background: "#f2e3c2", border: "1px solid #b38b52", padding: "6px 8px", fontSize: 14 }}>
          {chartVariantConfig.description}
        </div>

	        <div className="flex flex-row gap-4 overflow-x-auto pb-4">
	          <div style={{ minWidth: 620 }}>
            <NorthIndianChart
              title={chartVariantConfig.chartTitle}
              houses={houses}
              centered={false}
              className="w-full"
            />
            {error ? <div className="text-red-700 mt-2">{error}</div> : null}
            {loading ? <div className="text-sm text-gray-700 mt-2">Выполняем расчёт...</div> : null}
	          </div>
          <div style={{ minWidth: 520, maxWidth: 560 }}>
            <div className="birth-panel-title">ДАННЫЕ РОЖДЕНИЯ (локально)</div>
            <div style={{ background: "#e8d6b0", border: "1px solid #b38b52", padding: "10px 12px" }}>
              <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
                <tbody>
                <tr>
                  <td style={{ width: "50%", padding: "2px 4px" }}>Имя</td>
                  <td style={{ padding: "2px 4px" }}>Фамилия</td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                      value={personName}
                      onChange={(e) => setPersonName(e.target.value)}
                    />
                  </td>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                    />
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>Дата</td>
                  <td style={{ padding: "2px 4px" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number"
                        style={{ width: 70, background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                        value={birthParts.year}
                        onChange={(e) => handlePartChange("year", parseInt(e.target.value || "0", 10))}
                      />
                      <input
                        type="number"
                        style={{ width: 46, background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                        value={birthParts.month}
                        onChange={(e) => handlePartChange("month", parseInt(e.target.value || "0", 10))}
                      />
                      <input
                        type="number"
                        style={{ width: 46, background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                        value={birthParts.day}
                        onChange={(e) => handlePartChange("day", parseInt(e.target.value || "0", 10))}
                      />
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>Время</td>
                  <td style={{ padding: "2px 4px" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number"
                        style={{ width: 46, background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                        value={birthParts.hour}
                        onChange={(e) => handlePartChange("hour", parseInt(e.target.value || "0", 10))}
                      />
                      <input
                        type="number"
                        style={{ width: 46, background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                        value={birthParts.minute}
                        onChange={(e) => handlePartChange("minute", parseInt(e.target.value || "0", 10))}
                      />
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>
                    <label>
                      <input type="radio" checked={gender === "male"} onChange={() => setGender("male")} /> Мужской
                    </label>
                  </td>
                  <td style={{ padding: "2px 4px" }}>
                    <label>
                      <input type="radio" checked={gender === "female"} onChange={() => setGender("female")} /> Женский
                    </label>
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>Страна</td>
                  <td style={{ padding: "2px 4px" }}>
	                    <select
	                      style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
	                      value={country}
	                      onChange={(e) => {
	                        const next = e.target.value;
	                        setCountry(next);
	                        setCityQuery("");
	                        setSelectedCity(null);
	                        setAutoApplyCity(true);
	                        setSuggestionsOpen(false);
	                      }}
	                    >
	                      {countryOptions.map((code) => (
	                        <option key={code} value={code}>
	                          {countryNameRU(code)} ({code})
	                        </option>
	                      ))}
	                    </select>
	                  </td>
	                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>Город</td>
                  <td style={{ padding: "2px 4px", position: "relative" }}>
                    <input
                      style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                      value={cityQuery}
                      onChange={(e) => handleCityInput(e.target.value)}
                      onFocus={() => setSuggestionsOpen(true)}
                      onBlur={() => {
                        if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                        blurTimerRef.current = window.setTimeout(() => setSuggestionsOpen(false), 120);
                      }}
                    />
                    {suggestionsOpen && suggestions.length > 0 ? (
                      <div
                        style={{
                          position: "absolute",
                          zIndex: 10,
                          background: "#f2e3c2",
                          border: "1px solid #b38b52",
                          width: "100%",
                          maxHeight: 200,
                          overflowY: "auto",
                          color: "#2b1c0f",
                        }}
                      >
	                        {suggestions.map((city) => (
	                          <div
	                            key={city.id}
	                            style={{ padding: "4px 6px", cursor: "pointer" }}
	                            onMouseDown={(e) => {
	                              e.preventDefault();
	                              handleCitySelect(city);
	                            }}
	                          >
	                            {city.nameRu}
	                            {city.country !== "RU" && city.nameRu !== city.name ? ` (${city.name})` : ""}
	                          </div>
	                        ))}
	                      </div>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>Широта (lat)</td>
                  <td style={{ padding: "2px 4px" }}>Долгота (lon)</td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                      value={lat}
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (!Number.isNaN(num)) {
                          setLat(num);
                          scheduleRebuild(birthParts);
                        }
                      }}
                    />
                  </td>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
                      value={lon}
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (!Number.isNaN(num)) {
                          setLon(num);
                          scheduleRebuild(birthParts);
                        }
                      }}
                    />
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>IANA часовой пояс</td>
                  <td style={{ padding: "2px 4px" }}>
                    <input style={{ width: "100%", background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }} value={ianaTz} readOnly />
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} style={{ padding: "2px 4px", fontSize: 12, color: "#4a3822" }}>
                    {utcString}
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} style={{ padding: "4px 4px" }}>
                    <label>
	                      <input
	                        type="checkbox"
	                        checked={enableTzCorrection}
	                        onChange={(e) => {
	                          const next = e.target.checked;
	                          setEnableTzCorrection(next);
	                          if (next) {
	                            // Start override from the auto-DST state (as in App)
	                            setDstManual(autoDst);
	                          } else {
	                            setDstManual(false);
	                          }
	                          scheduleRebuild(birthParts);
	                        }}
	                      />{" "}
	                      Включить ручную коррекцию
	                    </label>
	                    <input
	                      type="number"
	                      inputMode="numeric"
	                      style={{ width: 60, marginLeft: 8, background: "#f2e3c2", border: "1px solid #b38b52", padding: "2px 4px" }}
	                      value={tzCorrectionHours}
	                      onChange={(e) => {
                        const val = e.target.value;
                        const num = Number(val);
                        if (!Number.isNaN(num)) {
                          setTzCorrectionHours(num);
                          scheduleRebuild(birthParts);
                        }
                      }}
                      disabled={!enableTzCorrection}
                    />
                  </td>
                </tr>
                <tr>
	                  <td colSpan={2} style={{ padding: "2px 4px" }}>
	                    <label>
	                      <input
	                        type="checkbox"
	                        checked={enableTzCorrection ? dstManual : autoDst}
	                        disabled={!enableTzCorrection}
	                        onChange={(e) => {
	                          setDstManual(e.target.checked);
	                          scheduleRebuild(birthParts);
	                        }}
                      />{" "}
                      Принуд. DST +1ч
                    </label>
                    <div style={{ fontSize: 12, color: "#4a3822" }}>
                      DST выставляется автоматически по истории тайм-зоны. Снимите галочку, если в этот период переход не применялся.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} style={{ padding: "6px 4px" }}>
                    <button
                      type="button"
                      className={`${BUTTON_PRIMARY} w-full`}
                      style={{ background: "#f2e3c2", color: "#1f1309", border: "1px solid #b38b52", fontWeight: 700 }}
                      onClick={() => scheduleRebuild(birthParts)}
                    >
                      Построить натальную карту
                    </button>
                  </td>
                </tr>
                </tbody>
              </table>
            </div>
          </div>
	        </div>

        {planetTable}
      </div>
    </div>
  );
};

export default AdditionalChartPage;



