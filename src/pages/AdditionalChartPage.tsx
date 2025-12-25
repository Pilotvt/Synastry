// Локальная страница «Дополнительно»: без облака и анкеты, только расчёт и сохранение в файл.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import moment from "moment-timezone";
import tzLookup from "tz-lookup";
import { supabase } from "../lib/supabase";
import { loadChartTextResources, type ChartTextResources } from "../lib/textResources";
import NorthIndianChart from "../components/NorthIndianChart";
import OfflineAccessDialog from "../components/OfflineAccessDialog";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";
import { getTithiStatic, tithiOrdinalRu, tithiPakshaRu } from "../constants/tithi";
import { getRussianCities } from "../utils/russianCitiesClient";
import { requestNewChartReset } from "../utils/newChartRequest";
import { useOfflineMode } from "../utils/offlineMode";
import { norm, latinToRuName, ruToLat } from "../utils/transliterate";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";
const DEBOUNCE_MS = 800;
const ADDITIONAL_DRAFT_STORAGE_KEY = "synastry_additional_draft_v1";

const PAPER_BLOCK_BG = "#f1d6ae";
const BIRTH_FIELD_BG = "#f5e4c3";

type AdditionalRightTabId = "tithi" | "vimshottari-dasha" | "nakshatra" | "panchanga" | "sade-sati";
const ADDITIONAL_RIGHT_TABS: Array<{ id: AdditionalRightTabId; label: string }> = [
  { id: "tithi", label: "Титхи" },
  { id: "vimshottari-dasha", label: "Вимшотари даши" },
  { id: "nakshatra", label: "Накшатра" },
  { id: "panchanga", label: "Панчанга" },
  { id: "sade-sati", label: "Саде-Сати" },
];

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
  debug_info?: Record<string, unknown> | null;
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

function computeBuildMetaPreview({
  parts,
  ianaTz,
  enableTzCorrection,
  tzCorrectionHours,
  dstManual,
}: {
  parts: BirthParts;
  ianaTz: string;
  enableTzCorrection: boolean;
  tzCorrectionHours: number;
  dstManual: boolean;
}): BuildMeta | null {
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
    console.warn("Failed to build meta preview", err);
    return null;
  }
}

type TithiApiResponse = {
  tithi: number;
  paksha: "shukla" | "krishna";
  start_utc: string;
  end_utc: string;
  phase_angle_deg: number;
  illumination: number;
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
    ascTitle: string;
    headerAscLabel: string;
    longitudeLabel: string | null;
    description: string;
    skipPlanet: "sun" | "moon" | null;
  }
> = {
  rashi: {
    chartTitle: "КАРТА ВОСХОДЯЩЕГО ЗНАКА (RASHI)",
    ascTitle: "Восходящий знак",
    headerAscLabel: "Восходящий знак",
    longitudeLabel: null,
    description: "Базовая натальная карта. Асцендент определяет первый дом, все дома и описания рассчитываются относительно него.",
    skipPlanet: null,
  },
  chandra: {
    chartTitle: "ЛУННАЯ КАРТА (CHANDRA)",
    ascTitle: "Созвездие в 1 доме (Луна)",
    headerAscLabel: "Созвездие 1 дома (Луна)",
    longitudeLabel: "Луна",
    description: "Лунная карта. Первый дом - знак Луны, дома и трактовки пересчитаны относительно Луны.",
    skipPlanet: "moon",
  },
  surya: {
    chartTitle: "СОЛНЕЧНАЯ КАРТА (SURYA)",
    ascTitle: "Созвездие в 1 доме (Солнце)",
    headerAscLabel: "Созвездие 1 дома (Солнце)",
    longitudeLabel: "Солнце",
    description: "Солнечная карта. Первый дом - знак Солнца, дома и трактовки пересчитаны относительно Солнца.",
    skipPlanet: "sun",
  },
};

const EMPTY_STRING_MAP: Record<string, string> = Object.freeze({});
const EMPTY_BHAVA_MAP: Record<string, { title: string; body: string }> = Object.freeze({});
const EMPTY_CHART_TEXT_RESOURCES: ChartTextResources = Object.freeze({
  ascSignDescriptions: EMPTY_STRING_MAP,
  lagneshaDescriptions: EMPTY_STRING_MAP,
  lagneshaHouseDescriptions: EMPTY_STRING_MAP,
  atmaKarakaDescriptions: EMPTY_STRING_MAP,
  daraKarakaDescriptions: EMPTY_STRING_MAP,
  suryaBhavas: EMPTY_BHAVA_MAP,
  chandraBhavas: EMPTY_BHAVA_MAP,
  guruBhavas: EMPTY_BHAVA_MAP,
  budhaBhavas: EMPTY_BHAVA_MAP,
  shukraBhavas: EMPTY_BHAVA_MAP,
  shaniBhavas: EMPTY_BHAVA_MAP,
  mangalaBhavas: EMPTY_BHAVA_MAP,
  ketuBhavas: EMPTY_BHAVA_MAP,
  rahuBhavas: EMPTY_BHAVA_MAP,
});

const LAGNESHA_BY_ASC_SIGN: Record<string, string> = {
  Ar: "Ma",
  Ta: "Ve",
  Ge: "Me",
  Cn: "Mo",
  Le: "Su",
  Vi: "Me",
  Li: "Ve",
  Sc: "Ma",
  Sg: "Ju",
  Cp: "Sa",
  Aq: "Sa",
  Pi: "Ju",
};

const ARC_EPSILON = 1e-6;

type PlanetArcStat = {
  planet: string;
  percent: number;
  arcName: string;
  lon: number;
};

function splitDescription(text: string): { heading: string; body: string } {
  if (!text) return { heading: "", body: "" };
  const parts = text.split("\n");
  const heading = (parts.shift() ?? "").trim();
  const body = parts.join("\n").trim();
  if (!body) return { heading: "", body: heading };
  return { heading, body };
}

const EXALTATION_SIGNS: Record<string, readonly string[]> = {
  Su: ["Ar"],
  Mo: ["Ta"],
  Ra: ["Ta", "Ge"],
  Ju: ["Cn"],
  Me: ["Vi"],
  Ke: ["Sc", "Sg"],
  Ma: ["Cp"],
  Ve: ["Pi"],
};

const DEBILITATION_SIGNS: Record<string, readonly string[]> = {
  Sa: ["Ar"],
  Ke: ["Ta"],
  Ma: ["Cn"],
  Ve: ["Vi"],
  Su: ["Li"],
  Mo: ["Sc"],
  Ra: ["Sc"],
  Ju: ["Cp"],
  Me: ["Pi"],
};

const KARAKA_HOUSES: Record<string, readonly number[]> = {
  Su: [1, 9],
  Ju: [2, 5, 9, 10, 11],
  Ma: [3, 6],
  Mo: [4],
  Me: [4, 10],
  Sa: [6, 8, 10, 12],
};

const DIGBALA_HOUSES: Record<string, readonly number[]> = {
  Ju: [1],
  Me: [1],
  Mo: [4],
  Ve: [4],
  Sa: [7],
  Ma: [10],
  Su: [10],
};

const OWN_SIGN_SIGNS: Record<string, readonly string[]> = {
  Su: ["Le"],
  Mo: ["Cn"],
  Ma: ["Ar", "Sc"],
  Me: ["Ge", "Vi"],
  Ju: ["Sg", "Pi"],
  Ve: ["Ta", "Li"],
  Sa: ["Cp", "Aq"],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceFiniteNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return Number.NaN;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function extractChartCoords(value: unknown): { lat: number | null; lon: number | null } {
  if (!isRecord(value)) return { lat: null, lon: null };
  const debugInfo = value.debug_info;
  if (!isRecord(debugInfo)) return { lat: null, lon: null };
  const payload = isRecord(debugInfo.payload) ? debugInfo.payload : null;
  const lat = coerceFiniteNumber((payload && (payload.latitude ?? payload.lat)) ?? debugInfo.latitude ?? debugInfo.lat);
  const lon = coerceFiniteNumber((payload && (payload.longitude ?? payload.lon)) ?? debugInfo.longitude ?? debugInfo.lon);
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

type AdditionalDraftCity = {
  id: string;
  name: string;
  nameRu: string;
  lat: number;
  lon: number;
  country: string;
};

type AdditionalDraftV1 = {
  v: 1;
  personName: string;
  lastName: string;
  gender: "male" | "female";
  country: string;
  cityQuery: string;
  selectedCity: AdditionalDraftCity | null;
  birthParts: BirthParts;
  lat: number;
  lon: number;
  ianaTz: string;
  enableTzCorrection: boolean;
  tzCorrectionHours: number;
  dstManual: boolean;
  chartVariant: ChartVariant;
  chart: ChartResponse | null;
  meta: BuildMeta | null;
  updatedAt: number;
};

function parseAdditionalDraftCity(city: unknown): AdditionalDraftCity | null {
  if (!city || typeof city !== "object") return null;
  const obj = city as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  const name = typeof obj.name === "string" ? obj.name : "";
  const nameRu = typeof obj.nameRu === "string" ? obj.nameRu : "";
  const country = typeof obj.country === "string" ? obj.country : "";
  const lat = coerceFiniteNumber(obj.lat);
  const lon = coerceFiniteNumber(obj.lon);
  if (!id || !name || !country || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { id, name, nameRu: nameRu || name, lat, lon, country };
}

function parseBirthPartsFromIso(value: unknown): BirthParts | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = moment.parseZone(value, moment.ISO_8601, true);
  if (!parsed.isValid()) return null;
  return normalizeParts({
    year: parsed.year(),
    month: parsed.month() + 1,
    day: parsed.date(),
    hour: parsed.hour(),
    minute: parsed.minute(),
  });
}

function readAdditionalDraft(): AdditionalDraftV1 | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ADDITIONAL_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AdditionalDraftV1>;
    if (!parsed || parsed.v !== 1) return null;
    const birthParts = parsed.birthParts ? normalizeParts(parsed.birthParts as BirthParts) : null;
    if (!birthParts) return null;
    const chartVariant =
      parsed.chartVariant === "rashi" || parsed.chartVariant === "chandra" || parsed.chartVariant === "surya"
        ? parsed.chartVariant
        : "rashi";
    return {
      v: 1,
      personName: typeof parsed.personName === "string" ? parsed.personName : "",
      lastName: typeof parsed.lastName === "string" ? parsed.lastName : "",
      gender: parsed.gender === "female" ? "female" : "male",
      country: typeof parsed.country === "string" ? parsed.country : "RU",
      cityQuery: typeof parsed.cityQuery === "string" ? parsed.cityQuery : "",
      selectedCity: parseAdditionalDraftCity(parsed.selectedCity) ?? null,
      birthParts,
      lat: typeof parsed.lat === "number" ? parsed.lat : Number(parsed.lat ?? 54.84152),
      lon: typeof parsed.lon === "number" ? parsed.lon : Number(parsed.lon ?? 73.30174),
      ianaTz: typeof parsed.ianaTz === "string" ? parsed.ianaTz : "Asia/Omsk",
      enableTzCorrection: Boolean(parsed.enableTzCorrection),
      tzCorrectionHours: typeof parsed.tzCorrectionHours === "number" ? parsed.tzCorrectionHours : Number(parsed.tzCorrectionHours ?? 0),
      dstManual: Boolean(parsed.dstManual),
      chartVariant,
      chart: (parsed.chart as ChartResponse) ?? null,
      meta: (parsed.meta as BuildMeta) ?? null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch (error) {
    console.warn("Failed to read Additional draft state", error);
    return null;
  }
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

function daysInMonth(year: number, month: number): number {
  const safeYear = Number.isFinite(year) ? year : 1990;
  const safeMonth = Number.isFinite(month) ? month : 1;
  return moment.utc().year(safeYear).month(Math.max(0, Math.min(11, safeMonth - 1))).daysInMonth();
}

function applyOverflowChange(prevParts: BirthParts, field: keyof BirthParts, nextValue: number): BirthParts {
  const prev = normalizeParts(prevParts);
  if (!Number.isFinite(nextValue)) return prev;

  if (field === "year") {
    const y = Math.trunc(nextValue) || prev.year;
    const maxDay = daysInMonth(y, prev.month);
    return { ...prev, year: y, day: Math.min(prev.day, maxDay) };
  }

  if (field === "month") {
    const monthRaw = Math.trunc(nextValue);
    const monthIndex = monthRaw - 1;
    const yearDelta = monthRaw < 1 || monthRaw > 12 ? Math.floor(monthIndex / 12) : 0;
    const normalizedMonthIndex = monthIndex - yearDelta * 12;
    const m = normalizedMonthIndex + 1;
    const y = prev.year + yearDelta;
    const maxDay = daysInMonth(y, m);
    const nextMonth = Math.max(1, Math.min(12, m));
    return { ...prev, year: y, month: nextMonth, day: Math.min(prev.day, maxDay) };
  }

  if (field === "day" || field === "hour" || field === "minute") {
    const base = moment
      .utc()
      .year(prev.year)
      .month(prev.month - 1)
      .date(prev.day)
      .hour(prev.hour)
      .minute(prev.minute)
      .second(0)
      .millisecond(0);

    if (field === "day") {
      const maxDay = daysInMonth(prev.year, prev.month);
      const value = Math.trunc(nextValue);
      if (value >= 1 && value <= maxDay) {
        return { ...prev, day: value };
      }
      base.add(value - prev.day, "days");
    }

    if (field === "hour") {
      const value = Math.trunc(nextValue);
      if (value >= 0 && value <= 23) {
        return { ...prev, hour: value };
      }
      base.add(value - prev.hour, "hours");
    }

    if (field === "minute") {
      const value = Math.trunc(nextValue);
      if (value >= 0 && value <= 59) {
        return { ...prev, minute: value };
      }
      base.add(value - prev.minute, "minutes");
    }

    return {
      year: base.year(),
      month: base.month() + 1,
      day: base.date(),
      hour: base.hour(),
      minute: base.minute(),
    };
  }

  return prev;
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

function formatDegreesWithoutSeconds(value: number): string {
  const normalized = ((value % 360) + 360) % 360;
  const deg = Math.floor(normalized);
  const minutes = Math.floor((normalized - deg) * 60);
  return `${deg}\u00B0 ${minutes.toString().padStart(2, "0")}'`;
}

function formatArcDegree(value: number): string {
  const normalized = ((value % 360) + 360) % 360;
  let deg = Math.floor(normalized);
  let minutes = Math.round((normalized - deg) * 60);
  if (minutes === 60) {
    minutes = 0;
    deg = (deg + 1) % 360;
  }
  return `${deg}\u00B0 ${minutes.toString().padStart(2, "0")}'`;
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
  const [offlineModeEnabled, setOfflineModeEnabled] = useOfflineMode();
  const [offlineDialogOpen, setOfflineDialogOpen] = useState(false);
  const initialDraft = useMemo(() => readAdditionalDraft(), []);

  const openFileInputRef = useRef<HTMLInputElement | null>(null);

  const [chart, setChart] = useState<ChartResponse | null>(() => initialDraft?.chart ?? null);
  const [meta, setMeta] = useState<BuildMeta | null>(() => initialDraft?.meta ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [personName, setPersonName] = useState(() => initialDraft?.personName ?? "");
  const [lastName, setLastName] = useState(() => initialDraft?.lastName ?? "");
  const [gender, setGender] = useState<"male" | "female">(() => initialDraft?.gender ?? "male");
  const [country, setCountry] = useState(() => initialDraft?.country ?? "RU");
  const [countryOptions, setCountryOptions] = useState<string[]>(["RU"]);
  const [cityQuery, setCityQuery] = useState(() => initialDraft?.cityQuery ?? "Омск");
  const [selectedCity, setSelectedCity] = useState<CitySuggestion | null>(() => {
    const draftCity = initialDraft?.selectedCity;
    if (!draftCity) return null;
    return makeCitySuggestion(draftCity);
  });
  const [cities, setCities] = useState<CitySuggestion[]>([]);
  const cityCacheRef = useRef<Map<string, CitySuggestion[]>>(new Map());
  const [birthParts, setBirthParts] = useState<BirthParts>(() => initialDraft?.birthParts ?? defaultBirthParts);
  const [lat, setLat] = useState(() => initialDraft?.lat ?? 54.84152);
  const [lon, setLon] = useState(() => initialDraft?.lon ?? 73.30174);
  const [ianaTz, setIanaTz] = useState<string>(() => initialDraft?.ianaTz ?? "Asia/Omsk");
  const [enableTzCorrection, setEnableTzCorrection] = useState(() => initialDraft?.enableTzCorrection ?? false);
  const [tzCorrectionHours, setTzCorrectionHours] = useState(() => initialDraft?.tzCorrectionHours ?? 0);
  const [dstManual, setDstManual] = useState(() => initialDraft?.dstManual ?? false);
  const [autoDst, setAutoDst] = useState(() => Boolean(initialDraft?.meta?.autoDstMinutes && initialDraft.meta.autoDstMinutes > 0));
  const [autoApplyCity, setAutoApplyCity] = useState(() => !(initialDraft?.selectedCity));
  const [chartVariant, setChartVariant] = useState<ChartVariant>(() => initialDraft?.chartVariant ?? "rashi");
  const [chartTextResources, setChartTextResources] = useState<ChartTextResources | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<ElectronLicenseStatus | null>(null);
  const isLicensed = Boolean(licenseStatus?.licensed);
  const [fullDetailsOpen, setFullDetailsOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<AdditionalRightTabId>("tithi");
  const fullDetailsRequestedRef = useRef(false);
  const [tithiInfo, setTithiInfo] = useState<TithiApiResponse | null>(null);
  const [tithiLoading, setTithiLoading] = useState(false);
  const [tithiError, setTithiError] = useState<string | null>(null);
  const tithiAbortRef = useRef<AbortController | null>(null);
  const tithiDebounceRef = useRef<number | null>(null);
  const [debounceTimer, setDebounceTimer] = useState<number | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const blurTimerRef = useRef<number | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const buildAbortRef = useRef<AbortController | null>(null);
  const buildSeqRef = useRef(0);
  const buildChartRef = useRef<((parts: BirthParts) => Promise<void> | void) | null>(null);

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
    let isActive = true;
    loadChartTextResources()
      .then((resources) => {
        if (!isActive) return;
        setChartTextResources((prev) => prev ?? resources);
      })
      .catch((err) => {
        if (import.meta.env.DEV) {
          console.error("Failed to load chart text resources (Additional)", err);
        }
      });
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = typeof window !== "undefined" ? window.electronAPI?.license : undefined;
        const status = await api?.getStatus?.();
        if (!cancelled) setLicenseStatus(status ?? null);
      } catch {
        if (!cancelled) setLicenseStatus(null);
      }
    })();
    const unsub =
      typeof window !== "undefined"
        ? window.electronAPI?.license?.onStatus?.((s) => {
            setLicenseStatus(s ?? null);
          })
        : undefined;
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  useEffect(() => {
    if (!isLicensed) return;
    if (!fullDetailsRequestedRef.current) return;
    fullDetailsRequestedRef.current = false;
    setFullDetailsOpen(true);
  }, [isLicensed]);

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
      return computeBuildMetaPreview({ parts, ianaTz, enableTzCorrection, tzCorrectionHours, dstManual });
    },
    [ianaTz, enableTzCorrection, tzCorrectionHours, dstManual],
  );

  const metaPreview = useMemo(
    () => computeBuildMetaPreview({ parts: birthParts, ianaTz, enableTzCorrection, tzCorrectionHours, dstManual }),
    [birthParts, dstManual, enableTzCorrection, ianaTz, tzCorrectionHours],
  );

  useEffect(() => {
    if (!metaPreview) return;
    setAutoDst(metaPreview.autoDstMinutes > 0);
  }, [metaPreview?.autoDstMinutes]);

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
      const seq = ++buildSeqRef.current;
      buildAbortRef.current?.abort();
      const controller = new AbortController();
      buildAbortRef.current = controller;
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
          signal: controller.signal,
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Ошибка сервера: ${res.status} ${txt}`);
        }
        const json = (await res.json()) as ChartResponse;
        if (controller.signal.aborted || seq !== buildSeqRef.current) return;
        setChart(json);
        setMeta(metaPayload);
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setChart(null);
      } finally {
        if (seq === buildSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [lat, lon, recomputeMeta],
  );

  useEffect(() => {
    buildChartRef.current = buildChart;
  }, [buildChart]);

  useEffect(() => {
    if (rightPanelTab !== "tithi") return;
    const datetimeIso = metaPreview?.datetimeIso ?? meta?.datetimeIso ?? null;
    if (!datetimeIso) {
      setTithiInfo(null);
      setTithiLoading(false);
      setTithiError(null);
      return;
    }

    if (tithiDebounceRef.current) {
      clearTimeout(tithiDebounceRef.current);
    }
    tithiAbortRef.current?.abort();
    const controller = new AbortController();
    tithiAbortRef.current = controller;

    tithiDebounceRef.current = window.setTimeout(() => {
      setTithiLoading(true);
      setTithiError(null);

      (async () => {
        try {
          const endpoint = `${API_BASE_URL.replace(/\/$/, "")}/api/tithi`;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ datetime_iso: datetimeIso }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Ошибка сервера: ${res.status} ${txt}`);
          }
          const json = (await res.json()) as TithiApiResponse;
          if (controller.signal.aborted) return;
          setTithiInfo(json);
        } catch (err) {
          if (controller.signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          setTithiError(msg);
          setTithiInfo(null);
        } finally {
          if (!controller.signal.aborted) setTithiLoading(false);
        }
      })();
    }, 250);

    return () => {
      if (tithiDebounceRef.current) clearTimeout(tithiDebounceRef.current);
      controller.abort();
    };
  }, [meta?.datetimeIso, metaPreview?.datetimeIso, rightPanelTab]);

  const scheduleRebuild = useCallback(
    (nextParts: BirthParts) => {
      setBirthParts(nextParts);
      if (debounceTimer) clearTimeout(debounceTimer);
      const handle = window.setTimeout(() => void buildChartRef.current?.(nextParts), DEBOUNCE_MS);
      setDebounceTimer(handle);
    },
    [debounceTimer],
  );

  const buildNow = useCallback(
    (nextParts: BirthParts) => {
      setBirthParts(nextParts);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        setDebounceTimer(null);
      }
      void buildChartRef.current?.(nextParts);
    },
    [debounceTimer],
  );

  const applyImportedPayload = useCallback(
    (payload: unknown) => {
      if (!isRecord(payload)) {
        setError("Файл не распознан: неверный формат JSON.");
        return;
      }

      const root = isRecord(payload.payload) ? (payload.payload as Record<string, unknown>) : payload;
      const chartValue = root.chart;
      const metaValue = root.meta;
      const profileValue = root.profile;
      const chartCoords = extractChartCoords(chartValue);

      setError(null);

      let importedParts: BirthParts | null = null;

      if (isRecord(profileValue)) {
        const personNameRaw = typeof profileValue.personName === "string" ? profileValue.personName : "";
        const lastNameRaw = typeof profileValue.lastName === "string" ? profileValue.lastName : "";
        const genderRaw = profileValue.gender === "female" ? "female" : profileValue.gender === "male" ? "male" : null;
        const countryRaw = typeof profileValue.country === "string" ? profileValue.country : "";
        const cityQueryRaw = typeof profileValue.cityQuery === "string" ? profileValue.cityQuery : "";
        const selectedCityRaw = typeof profileValue.selectedCity === "string" ? profileValue.selectedCity : "";
        const cityNameRuRaw = typeof profileValue.cityNameRu === "string" ? profileValue.cityNameRu : "";
        const latRaw = coerceFiniteNumber(profileValue.lat);
        const lonRaw = coerceFiniteNumber(profileValue.lon);
        const latResolved = Number.isFinite(latRaw)
          ? latRaw
          : (typeof chartCoords.lat === "number" && Number.isFinite(chartCoords.lat) ? chartCoords.lat : null);
        const lonResolved = Number.isFinite(lonRaw)
          ? lonRaw
          : (typeof chartCoords.lon === "number" && Number.isFinite(chartCoords.lon) ? chartCoords.lon : null);

        setPersonName(personNameRaw);
        setLastName(lastNameRaw);
        if (genderRaw) setGender(genderRaw);
        if (countryRaw) setCountry(countryRaw);
        if (cityQueryRaw) setCityQuery(cityQueryRaw);
        if (typeof latResolved === "number") setLat(latResolved);
        if (typeof lonResolved === "number") setLon(lonResolved);

        importedParts = parseBirthPartsFromIso(profileValue.birth);
        if (importedParts) setBirthParts(importedParts);

        const enableTzCorrectionRaw =
          typeof profileValue.enableTzCorrection === "boolean" ? profileValue.enableTzCorrection : Boolean(profileValue.enableTzCorrection);
        const tzCorrectionHoursRaw =
          typeof profileValue.tzCorrectionHours === "number" ? profileValue.tzCorrectionHours : Number(profileValue.tzCorrectionHours ?? 0);
        const dstManualRaw = typeof profileValue.dstManual === "boolean" ? profileValue.dstManual : Boolean(profileValue.dstManual);
        setEnableTzCorrection(enableTzCorrectionRaw);
        if (Number.isFinite(tzCorrectionHoursRaw)) setTzCorrectionHours(tzCorrectionHoursRaw);
        setDstManual(dstManualRaw);

        if (selectedCityRaw && typeof latResolved === "number" && typeof lonResolved === "number") {
          const countryForCity = (countryRaw || country || "RU").toUpperCase();
          const suggestion = makeCitySuggestion({
            id: `${countryForCity}:${selectedCityRaw}:${latResolved}:${lonResolved}`,
            name: selectedCityRaw,
            nameRu: cityNameRuRaw || latinToRuName(selectedCityRaw),
            country: countryForCity,
            lat: latResolved,
            lon: lonResolved,
          });
          setSelectedCity(suggestion);
          setAutoApplyCity(false);
          setSuggestionsOpen(false);
        } else {
          setSelectedCity(null);
          setAutoApplyCity(true);
        }
      }

      if (isRecord(metaValue)) {
        const iana = typeof metaValue.ianaTz === "string" ? metaValue.ianaTz : "";
        if (iana) setIanaTz(iana);
        const nextMeta = metaValue as BuildMeta;
        setMeta(nextMeta);
        setAutoDst(Boolean(nextMeta.autoDstMinutes && nextMeta.autoDstMinutes > 0));
      }

      if (chartValue && typeof chartValue === "object") {
        setChart(chartValue as ChartResponse);
      } else if (importedParts) {
        setChart(null);
        setMeta(null);
        scheduleRebuild(importedParts);
      }
    },
    [country, scheduleRebuild],
  );

  const handleOpenFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text) as unknown;
        applyImportedPayload(json);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Не удалось открыть файл: ${msg}`);
      }
    },
    [applyImportedPayload],
  );

  const handleOpenFromFileClick = useCallback(() => {
    openFileInputRef.current?.click();
  }, []);

  useEffect(() => {
    if (initialDraft?.chart && initialDraft?.meta) return;
    void buildChart(birthParts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      try {
        const cityPayload = selectedCity
          ? {
              id: selectedCity.id,
              name: selectedCity.name,
              nameRu: selectedCity.nameRu,
              lat: selectedCity.lat,
              lon: selectedCity.lon,
              country: selectedCity.country,
            }
          : null;
        const payload: AdditionalDraftV1 = {
          v: 1,
          personName,
          lastName,
          gender,
          country,
          cityQuery,
          selectedCity: cityPayload,
          birthParts,
          lat,
          lon,
          ianaTz,
          enableTzCorrection,
          tzCorrectionHours,
          dstManual,
          chartVariant,
          chart: chart && meta ? chart : null,
          meta: chart && meta ? meta : null,
          updatedAt: Date.now(),
        };
        window.localStorage.setItem(ADDITIONAL_DRAFT_STORAGE_KEY, JSON.stringify(payload));
      } catch (error) {
        console.warn("Failed to autosave Additional draft state", error);
      }
    }, 250);
  }, [
    birthParts,
    chart,
    chartVariant,
    cityQuery,
    country,
    dstManual,
    enableTzCorrection,
    gender,
    ianaTz,
    lastName,
    lat,
    lon,
    meta,
    personName,
    selectedCity,
    tzCorrectionHours,
  ]);

  useEffect(
    () => () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      buildAbortRef.current?.abort();
    },
    [debounceTimer],
  );

  const handlePartChange = (field: keyof BirthParts, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = applyOverflowChange(birthParts, field, value);
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

  const ianaTzDisplay = useMemo(() => {
    if (!ianaTz) return "";
    const finalOffsetMinutes = metaPreview?.finalOffsetMinutes ?? meta?.finalOffsetMinutes ?? null;
    if (typeof finalOffsetMinutes !== "number" || !Number.isFinite(finalOffsetMinutes)) return ianaTz;
    return `${ianaTz}, ${formatOffset(finalOffsetMinutes)}`;
  }, [ianaTz, meta?.finalOffsetMinutes, metaPreview?.finalOffsetMinutes]);

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

  const arcsForRender = useMemo(() => (Array.isArray(chart?.constellation_arcs) ? chart.constellation_arcs : []), [chart]);

  const planetsByArc = useMemo(() => {
    const map = new Map<string, ChartResponse["planets"]>();
    if (!chart) return map;
    const arcs = arcsForRender;
    arcs.forEach((a) => map.set(a.iau_code, []));

    const inArc = (lon: number, start: number, end: number) => {
      const l = ((lon % 360) + 360) % 360;
      const s = ((start % 360) + 360) % 360;
      const e = ((end % 360) + 360) % 360;
      if (s <= e) return l >= s && l < e;
      return l >= s || l < e;
    };

    if (Array.isArray(chart.planets)) {
      chart.planets.forEach((p) => {
        const code = p.iau_constellation || "";
        if (code && map.has(code)) {
          map.get(code)!.push(p);
          return;
        }
        for (const a of arcs) {
          if (inArc(p.lon_sidereal, a.lon_start_deg, a.lon_end_deg)) {
            const arr = map.get(a.iau_code) ?? [];
            arr.push(p);
            map.set(a.iau_code, arr);
            break;
          }
        }
      });
    }

    for (const [k, arr] of map.entries()) {
      if (arr && arr.length) arr.sort((a, b) => a.lon_sidereal - b.lon_sidereal);
      map.set(k, arr);
    }
    return map;
  }, [arcsForRender, chart]);

  const planetMarkers = useMemo(() => {
    const markers = new Map<string, string[]>();
    if (!chart?.planets) return markers;

    chart.planets.forEach((planet) => {
      const symbols: string[] = [];
      const sign = planet.sign;
      const rotatedHouse = rotateHouseNumber(planet.house ?? null, variantShift);
      if (sign && EXALTATION_SIGNS[planet.name]?.includes(sign)) {
        symbols.push("\u2191");
      }
      if (sign && DEBILITATION_SIGNS[planet.name]?.includes(sign)) {
        symbols.push("\u2193");
      }
      if (rotatedHouse && KARAKA_HOUSES[planet.name]?.includes(rotatedHouse)) {
        symbols.push("\u25cb");
      }
      if (rotatedHouse && DIGBALA_HOUSES[planet.name]?.includes(rotatedHouse)) {
        symbols.push("\u25a1");
      }
      if (sign && OWN_SIGN_SIGNS[planet.name]?.includes(sign)) {
        symbols.push("\u2302");
      }
      if (symbols.length) {
        markers.set(planet.name, symbols);
      }
    });

    const pushMarker = (name: string, symbol: string) => {
      const arr = markers.get(name) ?? [];
      if (!arr.includes(symbol)) {
        arr.push(symbol);
        markers.set(name, arr);
      }
    };

    const sun = chart.planets.find((p) => p.name === "Su") || null;
    if (sun) {
      const sunRotatedHouse = rotateHouseNumber(sun.house ?? null, variantShift);
      const sunDeg = ((sun.lon_sidereal % 30) + 30) % 30;
      chart.planets.forEach((p) => {
        if (p.name === "Su" || p.name === "Mo" || p.name === "Ra" || p.name === "Ke") return;
        const prh = rotateHouseNumber(p.house ?? null, variantShift);
        if (!prh || !sunRotatedHouse || prh !== sunRotatedHouse) return;
        const pDeg = ((p.lon_sidereal % 30) + 30) % 30;
        const diff = Math.abs(pDeg - sunDeg);

        const isJupiterExalt = p.sign && EXALTATION_SIGNS["Ju"]?.includes(p.sign);
        const isJupiterDigbala = typeof prh === "number" && DIGBALA_HOUSES["Ju"]?.includes(prh);
        const jupThresh = isJupiterExalt || isJupiterDigbala ? 5 : 7;

        const thresholds: Record<string, number> = {
          Me: 3,
          Ve: 5,
          Ma: 5,
          Sa: 10,
          Ju: jupThresh,
        };
        const thr = thresholds[p.name];
        if (typeof thr === "number") {
          if (diff < 1) {
            pushMarker(p.name, "\u263c");
          } else if (diff <= thr) {
            pushMarker(p.name, "\u25cf");
          }
        }
      });
    }

    const groupsByHouse = new Map<number, { name: string; deg: number }[]>();
    chart.planets.forEach((p) => {
      if (p.name === "Su" || p.name === "Mo" || p.name === "Ra" || p.name === "Ke") return;
      const prh = rotateHouseNumber(p.house ?? null, variantShift);
      if (!prh) return;
      const pDeg = ((p.lon_sidereal % 30) + 30) % 30;
      const arr = groupsByHouse.get(prh) ?? [];
      arr.push({ name: p.name, deg: pDeg });
      groupsByHouse.set(prh, arr);
    });
    for (const arr of groupsByHouse.values()) {
      if (arr.length < 2) continue;
      const n = arr.length;
      const visited = new Array(n).fill(false);
      const adj: number[][] = Array.from({ length: n }, () => []);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (Math.abs(arr[i].deg - arr[j].deg) < 1) {
            adj[i].push(j);
            adj[j].push(i);
          }
        }
      }
      const stack: number[] = [];
      const pushLoser = (idxs: number[]) => {
        if (idxs.length < 2) return;
        let minIdx = idxs[0];
        for (const k of idxs) {
          if (arr[k].deg < arr[minIdx].deg) minIdx = k;
        }
        idxs.forEach((k) => {
          if (k !== minIdx) pushMarker(arr[k].name, "\u00d8");
        });
      };
      for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        stack.length = 0;
        const comp: number[] = [];
        stack.push(i);
        visited[i] = true;
        while (stack.length) {
          const v = stack.pop()!;
          comp.push(v);
          for (const w of adj[v]) {
            if (!visited[w]) {
              visited[w] = true;
              stack.push(w);
            }
          }
        }
        pushLoser(comp);
      }
    }

    return markers;
  }, [chart, variantShift]);

  const planetTable = useMemo(() => {
    if (!chart) return null;
    const iauNameByCode = new Map<string, string>();
    arcsForRender.forEach((a) => iauNameByCode.set(a.iau_code, a.iau_name_ru));

    const tableFontSize = 16;
    const cellStyle: React.CSSProperties = {
      padding: "1px 4px",
      verticalAlign: "top",
      textAlign: "left",
      whiteSpace: "nowrap",
      fontWeight: 400,
      color: "#000",
      lineHeight: "18px",
    };
    const headerCellStyle: React.CSSProperties = {
      ...cellStyle,
      color: "#000",
      fontWeight: 700,
    };

    return (
      <div style={{ maxWidth: "1450px", width: "100%", margin: "16px 0 0" }}>
        <div style={{ fontSize: tableFontSize, marginBottom: 6, color: "#1f1309" }}>
          <span style={{ fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.02em" }}>СОЗВЕЗДИЯ И ПЛАНЕТЫ</span>{" "}
          <span style={{ fontWeight: 400 }}>
            (
            {"↑-уча, ↓-нича, ○-карака, □-дигбала, ⌂-свой знак, ●-сожжёная,"}
            <br />
            {"Ø-проигравшая, ☼-супер сильная"}
            )
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "stretch", flexWrap: "nowrap", minWidth: 1082 }}>
            <div
              style={{
                width: "fit-content",
                minWidth: 650,
                maxWidth: 680,
                background: PAPER_BLOCK_BG,
                border: "1px solid #000",
                padding: "6px 8px",
              }}
            >
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: tableFontSize, color: "#000" }}>
                <thead>
                  <tr>
                    <th style={headerCellStyle}>Созвездие (код)</th>
                    <th style={headerCellStyle}>Lon start</th>
                    <th style={headerCellStyle}>Lon end</th>
                    <th style={headerCellStyle}>Планета</th>
                    <th style={headerCellStyle}>Истин. созв.</th>
                    <th style={headerCellStyle}>Долгота</th>
                    <th style={headerCellStyle}>Рет.</th>
                  </tr>
                </thead>
                <tbody>
                  {arcsForRender.map((arc) => {
                    const planets = planetsByArc.get(arc.iau_code) ?? [];
                    if (planets.length === 0) {
                      return (
                        <tr key={arc.iau_code}>
                          <td style={cellStyle}>
                            {arc.iau_name_ru} ({arc.iau_code})
                          </td>
                          <td style={cellStyle}>{formatArcDegree(arc.lon_start_deg)}</td>
                          <td style={cellStyle}>{formatArcDegree(arc.lon_end_deg)}</td>
                          <td style={{ ...cellStyle, color: "rgba(0,0,0,0.45)" }}>-</td>
                          <td style={cellStyle}>-</td>
                          <td style={cellStyle}>-</td>
                          <td style={cellStyle}> </td>
                        </tr>
                      );
                    }

                    return planets.map((p, idx) => {
                      const iauCode = p.iau_constellation || arc.iau_code || "";
                      const iauNameRu = iauNameByCode.get(iauCode) || "";
                      const markersForPlanet = planetMarkers.get(p.name) ?? [];
                      const strength = p.house_strength ?? 0;
                      const strengthPercent = Math.round(strength * 100);
                      const strengthColor = (() => {
                        const percent = strength;
                        if (percent <= 0.1) {
                          return "#e53935";
                        } else if (percent < 0.5) {
                          const ratio = (percent - 0.1) / 0.4;
                          const r = Math.round(229 + (251 - 229) * ratio);
                          const g = Math.round(57 + (192 - 57) * ratio);
                          const b = Math.round(53 + (45 - 53) * ratio);
                          return `rgb(${r},${g},${b})`;
                        } else if (percent < 0.99) {
                          const ratio = (percent - 0.5) / 0.49;
                          const r = Math.round(251 + (67 - 251) * ratio);
                          const g = Math.round(192 + (160 - 192) * ratio);
                          const b = Math.round(45 + (71 - 45) * ratio);
                          return `rgb(${r},${g},${b})`;
                        } else {
                          return "#43a047";
                        }
                      })();

                      return (
                        <tr key={`${arc.iau_code}-${p.name}-${idx}`}>
                          {idx === 0 ? (
                            <>
                              <td rowSpan={planets.length} style={cellStyle}>
                                {arc.iau_name_ru} ({arc.iau_code})
                              </td>
                              <td rowSpan={planets.length} style={cellStyle}>
                                {formatArcDegree(arc.lon_start_deg)}
                              </td>
                              <td rowSpan={planets.length} style={cellStyle}>
                                {formatArcDegree(arc.lon_end_deg)}
                              </td>
                            </>
                          ) : null}
                          <td style={cellStyle}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <span
                                title={`Сила: ${strengthPercent}%`}
                                style={{
                                  display: "inline-block",
                                  width: "44px",
                                  height: "12px",
                                  borderRadius: "6px",
                                  background: "#444",
                                  position: "relative",
                                  overflow: "hidden",
                                  verticalAlign: "middle",
                                }}
                              >
                                <span
                                  style={{
                                    position: "absolute",
                                    left: 0,
                                    top: 0,
                                    height: "100%",
                                    width: `${strengthPercent}%`,
                                    background: strengthColor,
                                    borderRadius: "6px",
                                    transition: "width 0.3s, background 0.3s",
                                  }}
                                />
                              </span>
                              {markersForPlanet.length ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 16, lineHeight: 1 }}>
                                  {markersForPlanet.map((symbol, symbolIdx) => (
                                    <span key={`${p.name}-${symbol}-${symbolIdx}`}>{symbol}</span>
                                  ))}
                                </span>
                              ) : null}
                              <span>{PLANET_NAMES_RU[p.name] ?? p.name}</span>
                            </span>
                          </td>
                          <td style={cellStyle}>{iauNameRu ? `${iauNameRu} (${iauCode})` : p.iau_constellation || ""}</td>
                          <td style={cellStyle}>{formatDegreesWithoutSeconds(p.lon_sidereal)}</td>
                          <td style={cellStyle}>{p.is_retrograde ? "R" : ""}</td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
              </div>
            </div>

            <div
              style={{
                width: 520,
                minWidth: 480,
                maxWidth: 520,
                background: PAPER_BLOCK_BG,
                border: "1px solid #000",
                display: "flex",
                flexDirection: "column",
              }}
            >
            <div style={{ display: "flex", flexWrap: "nowrap", borderBottom: "1px solid #000", overflowX: "auto" }}>
              {ADDITIONAL_RIGHT_TABS.map((tab, idx) => {
                const active = tab.id === rightPanelTab;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setRightPanelTab(tab.id)}
                    className={`px-3 py-1.5 text-sm font-normal whitespace-nowrap ${
                      active
                        ? `${BUTTON_PRIMARY} cursor-default`
                        : "border border-black bg-[#f1d6ae] text-[#1f1309] transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
                    }`}
                    style={{
                      marginLeft: idx === 0 ? 0 : -1,
                    }}
                    disabled={active}
                    aria-pressed={active}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <div style={{ background: PAPER_BLOCK_BG, padding: "10px 12px", flex: "1 1 auto", minHeight: 220 }}>
              {rightPanelTab === "tithi" ? (
                tithiLoading ? (
                  <div style={{ fontSize: 14, color: "#000" }}>Загрузка…</div>
                ) : tithiError ? (
                  <div style={{ fontSize: 14, color: "#9b1c1c", whiteSpace: "pre-line" }}>{tithiError}</div>
                ) : tithiInfo ? (
                  (() => {
                    const staticInfo = getTithiStatic(tithiInfo.tithi);
                    const startLocal = moment.parseZone(tithiInfo.start_utc).tz(ianaTz).format("DD.MM.YYYY HH:mm");
                    const endLocal = moment.parseZone(tithiInfo.end_utc).tz(ianaTz).format("DD.MM.YYYY HH:mm");
                    const tithiLabel = `${tithiOrdinalRu(tithiInfo.tithi)} Лунные сутки - ${staticInfo.title}`;
                    const pakshaLabel = tithiPakshaRu(tithiInfo.paksha);
                    const headerLine = `${tithiLabel}; ${pakshaLabel}`;
                    const iconPath = `moon/tithi-${String(tithiInfo.tithi).padStart(2, "0")}.png`;

                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                          <img
                            src={publicAssetUrl(iconPath)}
                            alt={tithiLabel}
                            style={{ width: 120, height: 120, flex: "0 0 auto" }}
                          />
                          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <div style={{ fontSize: 16, color: "#000", marginBottom: 6, fontWeight: 400, lineHeight: "18px" }}>
                              {headerLine}
                            </div>
                            <div style={{ fontSize: 16, color: "#000", fontWeight: 400, lineHeight: "18px" }}>
                              <div>
                                Начало - {startLocal}
                              </div>
                              <div>
                                Конец - {endLocal}
                              </div>
                            </div>
                          </div>
                        </div>
                        {staticInfo.description ? (
                          <div style={{ fontSize: 16, color: "#000", fontWeight: 400, whiteSpace: "pre-line", lineHeight: "18px" }}>
                            {staticInfo.description}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()
                ) : (
                  <div style={{ fontSize: 14, color: "#000" }}>Пока пусто.</div>
                )
              ) : (
                <div style={{ fontSize: 14, color: "#000" }}>Пока пусто.</div>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    );
  }, [arcsForRender, chart, ianaTz, planetMarkers, planetsByArc, rightPanelTab, tithiError, tithiInfo, tithiLoading]);

  const headerLines = useMemo(() => {
    const cityLabel = selectedCity?.nameRu || selectedCity?.name || cityQuery || "-";
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

  const allowFullDetails = isLicensed && fullDetailsOpen;
  const ascSectionTitle = chartVariantConfig.ascTitle;
  const firstHouseBoxForText = houses.find((house) => house.houseNumber === 1);
  const ascSignCodeForText = firstHouseBoxForText?.sign ?? chart?.ascendant?.sign ?? "";
  const ascSignNameForText = SIGN_INFO[ascSignCodeForText]?.ru ?? ascSignCodeForText;
  const ascLongitudeValueForText =
    chartVariant === "chandra"
      ? moonPlanet?.lon_sidereal ?? null
      : chartVariant === "surya"
        ? sunPlanet?.lon_sidereal ?? null
        : chart?.ascendant?.lon_sidereal ?? null;
  const ascLongitudeTextForText =
    typeof ascLongitudeValueForText === "number" && Number.isFinite(ascLongitudeValueForText) ? degStr(ascLongitudeValueForText) : "";
  const ascDescription =
    (chartTextResources?.ascSignDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.ascSignDescriptions)[ascSignCodeForText] ?? "";

  const openOfflineAccessDialog = useCallback(async () => {
    const dialogFn = window.electronAPI?.ui?.showOfflineAccessDialog;
    if (typeof dialogFn !== "function") {
      setOfflineDialogOpen(true);
      return;
    }
    try {
      const response = await dialogFn();
      if (response === 1) {
        setOfflineModeEnabled(false);
        navigate("/", { replace: true });
      }
    } catch (error) {
      console.warn("Failed to show offline access dialog", error);
      setOfflineDialogOpen(true);
    }
  }, [navigate, setOfflineModeEnabled]);

  const handleFullDetailsClick = useCallback(() => {
    if (offlineModeEnabled) {
      void openOfflineAccessDialog();
      return;
    }
    if (isLicensed) {
      setFullDetailsOpen((prev) => !prev);
      return;
    }
    fullDetailsRequestedRef.current = true;
    try {
      window.electronAPI?.license?.requestPrompt?.();
    } catch (promptError) {
      console.warn("Failed to request license prompt from Additional full description CTA", promptError);
    }
  }, [isLicensed, offlineModeEnabled, openOfflineAccessDialog]);

  const handleOfflineRegister = useCallback(() => {
    setOfflineDialogOpen(false);
    setOfflineModeEnabled(false);
    navigate("/", { replace: true });
  }, [navigate, setOfflineModeEnabled]);

  const handleOfflineClose = useCallback(() => {
    setOfflineDialogOpen(false);
  }, []);

  const handleOfflineRestrictedNav = useCallback(() => {
    void openOfflineAccessDialog();
  }, [openOfflineAccessDialog]);

  const lagneshaCode = ascSignCodeForText ? LAGNESHA_BY_ASC_SIGN[ascSignCodeForText] ?? "" : "";
  const lagneshaName = lagneshaCode ? PLANET_NAMES_RU[lagneshaCode] ?? lagneshaCode : "";
  const lagneshaDescription =
    lagneshaCode
      ? (chartTextResources?.lagneshaDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.lagneshaDescriptions)[lagneshaCode] ?? ""
      : "";
  const lagneshaDescriptionParts = useMemo(() => splitDescription(lagneshaDescription), [lagneshaDescription]);
  const lagneshaHeading = lagneshaDescriptionParts.heading || lagneshaName || lagneshaCode;
  const lagneshaBody = lagneshaDescriptionParts.body || (!lagneshaDescriptionParts.heading ? lagneshaDescription : "");
  const lagneshaPlanet = useMemo(() => {
    if (!lagneshaCode || !chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === lagneshaCode) ?? null;
  }, [chart, lagneshaCode]);
  const lagneshaHouseNumber = rotateHouseNumber(lagneshaPlanet?.house ?? null, variantShift);
  const lagneshaHouseTitle = lagneshaHouseNumber ? `Лагнеша в ${lagneshaHouseNumber}-м доме` : "";
  const lagneshaHouseDescription = lagneshaHouseNumber
    ? (chartTextResources?.lagneshaHouseDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.lagneshaHouseDescriptions)[String(lagneshaHouseNumber)] ??
      ""
    : "";
  const lagneshaHouseDescriptionParts = useMemo(() => splitDescription(lagneshaHouseDescription), [lagneshaHouseDescription]);
  const lagneshaHouseHeading = lagneshaHouseDescriptionParts.heading || lagneshaHouseTitle;
  const lagneshaHouseBody =
    lagneshaHouseDescriptionParts.body || (!lagneshaHouseDescriptionParts.heading ? lagneshaHouseDescription : "");

  const planetArcStats = useMemo<PlanetArcStat[]>(() => {
    if (!chart?.planets) return [];
    const arcs = arcsForRender;
    const normalize = (deg: number) => ((deg % 360) + 360) % 360;
    const inArc = (lon: number, start: number, end: number) => {
      const l = normalize(lon);
      const s = normalize(start);
      const e = normalize(end);
      if (s <= e) return l >= s && l < e;
      return l >= s || l < e;
    };

    return chart.planets.reduce<PlanetArcStat[]>((acc, planet) => {
      if (typeof planet.lon_sidereal !== "number" || !Number.isFinite(planet.lon_sidereal)) {
        return acc;
      }
      const lon = normalize(planet.lon_sidereal);
      const percent = ((lon % 30) / 30) * 100;
      if (!Number.isFinite(percent)) {
        return acc;
      }

      let arcName = planet.nakshatra || "";
      if (!arcName && arcs.length) {
        const found = arcs.find((arc) => inArc(lon, arc.lon_start_deg, arc.lon_end_deg));
        if (found) {
          arcName = found.iau_name_ru || found.iau_code || "";
        }
      }
      if (!arcName) {
        arcName = SIGN_INFO[planet.sign]?.ru ?? planet.sign ?? "";
      }

      acc.push({
        planet: planet.name,
        percent,
        arcName,
        lon,
      });
      return acc;
    }, []);
  }, [arcsForRender, chart]);

  const atmaKarakaEntry = useMemo<PlanetArcStat | null>(() => {
    if (!planetArcStats.length) return null;
    return planetArcStats.reduce<PlanetArcStat | null>((best, current) => {
      if (!best) return current;
      if (current.percent > best.percent + ARC_EPSILON) return current;
      if (Math.abs(current.percent - best.percent) <= ARC_EPSILON && current.lon > best.lon) return current;
      return best;
    }, null);
  }, [planetArcStats]);

  const daraKarakaEntry = useMemo<PlanetArcStat | null>(() => {
    if (!planetArcStats.length) return null;
    return planetArcStats.reduce<PlanetArcStat | null>((best, current) => {
      if (!best) return current;
      if (current.percent < best.percent - ARC_EPSILON) return current;
      if (Math.abs(current.percent - best.percent) <= ARC_EPSILON && current.lon < best.lon) return current;
      return best;
    }, null);
  }, [planetArcStats]);

  const atmaKarakaCode = atmaKarakaEntry?.planet ?? "";
  const atmaKarakaName = atmaKarakaCode ? PLANET_NAMES_RU[atmaKarakaCode] ?? atmaKarakaCode : "";
  const atmaKarakaPercent = typeof atmaKarakaEntry?.percent === "number" ? atmaKarakaEntry.percent : null;
  const atmaKarakaArcLabel = atmaKarakaEntry?.arcName ?? "";
  const atmaKarakaDescription =
    atmaKarakaCode
      ? (chartTextResources?.atmaKarakaDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.atmaKarakaDescriptions)[atmaKarakaCode] ?? ""
      : "";
  const atmaKarakaDescriptionParts = useMemo(() => splitDescription(atmaKarakaDescription), [atmaKarakaDescription]);
  const atmaKarakaHeading = atmaKarakaDescriptionParts.heading || atmaKarakaName || atmaKarakaCode;
  const atmaKarakaBody = atmaKarakaDescriptionParts.body || (!atmaKarakaDescriptionParts.heading ? atmaKarakaDescription : "");

  const daraKarakaCode = daraKarakaEntry?.planet ?? "";
  const daraKarakaName = daraKarakaCode ? PLANET_NAMES_RU[daraKarakaCode] ?? daraKarakaCode : "";
  const daraKarakaPercent = typeof daraKarakaEntry?.percent === "number" ? daraKarakaEntry.percent : null;
  const daraKarakaArcLabel = daraKarakaEntry?.arcName ?? "";
  const daraKarakaDescription =
    daraKarakaCode
      ? (chartTextResources?.daraKarakaDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.daraKarakaDescriptions)[daraKarakaCode] ?? ""
      : "";
  const daraKarakaDescriptionParts = useMemo(() => splitDescription(daraKarakaDescription), [daraKarakaDescription]);
  const daraKarakaHeading = daraKarakaDescriptionParts.heading || daraKarakaName || daraKarakaCode;
  const daraKarakaBody = daraKarakaDescriptionParts.body || (!daraKarakaDescriptionParts.heading ? daraKarakaDescription : "");

  const sunHouseNumber = rotateHouseNumber(sunPlanet?.house ?? null, variantShift);
  const sunHouseLookup = sunHouseNumber
    ? (chartTextResources?.suryaBhavas ?? EMPTY_CHART_TEXT_RESOURCES.suryaBhavas)[String(sunHouseNumber)]
    : undefined;
  const sunHouseHeading = sunHouseLookup?.title || (sunHouseNumber ? `Солнце в ${sunHouseNumber}-м доме` : "");
  const sunHouseBody = sunHouseLookup?.body ?? "";

  const moonHouseNumber = rotateHouseNumber(moonPlanet?.house ?? null, variantShift);
  const moonHouseLookup = moonHouseNumber
    ? (chartTextResources?.chandraBhavas ?? EMPTY_CHART_TEXT_RESOURCES.chandraBhavas)[String(moonHouseNumber)]
    : undefined;
  const moonHouseHeading = moonHouseLookup?.title || (moonHouseNumber ? `Луна в ${moonHouseNumber}-м доме` : "");
  const moonHouseBody = moonHouseLookup?.body ?? "";
  const showSunSection = chartVariantConfig.skipPlanet !== "sun" && Boolean(sunHouseBody);
  const showMoonSection = chartVariantConfig.skipPlanet !== "moon" && Boolean(moonHouseBody);

  const jupiterPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Ju") ?? null, [chart]);
  const jupiterHouseNumber = rotateHouseNumber(jupiterPlanet?.house ?? null, variantShift);
  const jupiterHouseLookup = jupiterHouseNumber
    ? (chartTextResources?.guruBhavas ?? EMPTY_CHART_TEXT_RESOURCES.guruBhavas)[String(jupiterHouseNumber)]
    : undefined;
  const jupiterHouseHeading = jupiterHouseLookup?.title || (jupiterHouseNumber ? `Юпитер в ${jupiterHouseNumber}-м доме` : "");
  const jupiterHouseBody = jupiterHouseLookup?.body ?? "";

  const mercuryPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Me") ?? null, [chart]);
  const mercuryHouseNumber = rotateHouseNumber(mercuryPlanet?.house ?? null, variantShift);
  const mercuryHouseLookup = mercuryHouseNumber
    ? (chartTextResources?.budhaBhavas ?? EMPTY_CHART_TEXT_RESOURCES.budhaBhavas)[String(mercuryHouseNumber)]
    : undefined;
  const mercuryHouseHeading = mercuryHouseLookup?.title || (mercuryHouseNumber ? `Меркурий в ${mercuryHouseNumber}-м доме` : "");
  const mercuryHouseBody = mercuryHouseLookup?.body ?? "";

  const venusPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Ve") ?? null, [chart]);
  const venusHouseNumber = rotateHouseNumber(venusPlanet?.house ?? null, variantShift);
  const venusHouseLookup = venusHouseNumber
    ? (chartTextResources?.shukraBhavas ?? EMPTY_CHART_TEXT_RESOURCES.shukraBhavas)[String(venusHouseNumber)]
    : undefined;
  const venusHouseHeading = venusHouseLookup?.title || (venusHouseNumber ? `Венера в ${venusHouseNumber}-м доме` : "");
  const venusHouseBody = venusHouseLookup?.body ?? "";

  const saturnPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Sa") ?? null, [chart]);
  const saturnHouseNumber = rotateHouseNumber(saturnPlanet?.house ?? null, variantShift);
  const saturnHouseLookup = saturnHouseNumber
    ? (chartTextResources?.shaniBhavas ?? EMPTY_CHART_TEXT_RESOURCES.shaniBhavas)[String(saturnHouseNumber)]
    : undefined;
  const saturnHouseHeading = saturnHouseLookup?.title || (saturnHouseNumber ? `Сатурн в ${saturnHouseNumber}-м доме` : "");
  const saturnHouseBody = saturnHouseLookup?.body ?? "";

  const marsPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Ma") ?? null, [chart]);
  const marsHouseNumber = rotateHouseNumber(marsPlanet?.house ?? null, variantShift);
  const marsHouseLookup = marsHouseNumber
    ? (chartTextResources?.mangalaBhavas ?? EMPTY_CHART_TEXT_RESOURCES.mangalaBhavas)[String(marsHouseNumber)]
    : undefined;
  const marsHouseHeading = marsHouseLookup?.title || (marsHouseNumber ? `Марс в ${marsHouseNumber}-м доме` : "");
  const marsHouseBody = marsHouseLookup?.body ?? "";

  const rahuPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Ra") ?? null, [chart]);
  const rahuHouseNumber = rotateHouseNumber(rahuPlanet?.house ?? null, variantShift);
  const rahuHouseLookup = rahuHouseNumber
    ? (chartTextResources?.rahuBhavas ?? EMPTY_CHART_TEXT_RESOURCES.rahuBhavas)[String(rahuHouseNumber)]
    : undefined;
  const rahuHouseHeading = rahuHouseLookup?.title || (rahuHouseNumber ? `Раху в ${rahuHouseNumber}-м доме` : "");
  const rahuHouseBody = rahuHouseLookup?.body ?? "";

  const ketuPlanet = useMemo(() => chart?.planets?.find((planet) => planet.name === "Ke") ?? null, [chart]);
  const ketuHouseNumber = rotateHouseNumber(ketuPlanet?.house ?? null, variantShift);
  const ketuHouseLookup = ketuHouseNumber
    ? (chartTextResources?.ketuBhavas ?? EMPTY_CHART_TEXT_RESOURCES.ketuBhavas)[String(ketuHouseNumber)]
    : undefined;
  const ketuHouseHeading = ketuHouseLookup?.title || (ketuHouseNumber ? `Кету в ${ketuHouseNumber}-м доме` : "");
  const ketuHouseBody = ketuHouseLookup?.body ?? "";

  return (
    <div className="additional-page min-h-screen bg-[#f5e4c3] text-[#2b1c0f]">
      <OfflineAccessDialog open={offlineDialogOpen} onClose={handleOfflineClose} onRegister={handleOfflineRegister} />
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
        .additional-page .birth-panel input:not([type="radio"]):not([type="checkbox"]):focus,
        .additional-page .birth-panel select:focus,
        .additional-page .birth-panel textarea:focus {
          outline: 2px solid #000;
          outline-offset: 1px;
          background: #f5e4c3 !important;
          box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
        }
        .additional-page .birth-panel input:not([type="radio"]):not([type="checkbox"]):focus-visible,
        .additional-page .birth-panel select:focus-visible,
        .additional-page .birth-panel textarea:focus-visible {
          outline: 2px solid #000;
          outline-offset: 1px;
        }
        .additional-page input[type="number"]::-webkit-outer-spin-button,
        .additional-page input[type="number"]::-webkit-inner-spin-button {
          opacity: 1;
          -webkit-appearance: inner-spin-button;
        }
      `}</style>
      <div className="container mx-auto px-4 pb-4 pt-3">
        <div className="max-w-[1450px] mx-auto w-full">
        <header className="mb-6">
          <div className="flex justify-between items-center mb-2">
            <h1 className="text-3xl font-bold text-[#2b1c0f]">Натальная карта</h1>
            <div className="flex flex-wrap gap-2 items-start justify-end">
              <button
                type="button"
                className="px-3 py-1 border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
                onClick={() => {
                  if (offlineModeEnabled) return handleOfflineRestrictedNav();
                  requestNewChartReset("additional");
                }}
              >
                Новая карта
              </button>
              <button
                type="button"
                className="px-3 py-1 border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
                onClick={() => {
                  if (offlineModeEnabled) return handleOfflineRestrictedNav();
                  navigate("/chart");
                }}
              >
                Натальная карта
              </button>
              <button
                type="button"
                className="px-3 py-1 border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
                onClick={() => {
                  if (offlineModeEnabled) return handleOfflineRestrictedNav();
                  navigate("/questionnaire");
                }}
              >
                Изменить анкету
              </button>
              <button
                type="button"
                className="px-3 py-1 border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
                onClick={async () => {
                  if (offlineModeEnabled) return handleOfflineRestrictedNav();
                  const { data: sessionData } = await supabase.auth.getSession();
                  const userId = sessionData?.session?.user?.id;
                  if (userId) {
                    navigate(`/user/${userId}`);
                  } else {
                    navigate("/");
                  }
                }}
              >
                Профиль
              </button>
              <button
                type="button"
                className="px-3 py-1 border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
                onClick={() => {
                  if (offlineModeEnabled) return handleOfflineRestrictedNav();
                  navigate("/sinastry");
                }}
              >
                Синастрия
              </button>
              <button
                type="button"
                className={`${BUTTON_PRIMARY} px-3 py-1.5 text-sm cursor-default`}
                disabled
              >
                Дополнительно
              </button>
            </div>
          </div>
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
        </header>

        <div className="flex flex-wrap gap-2 mb-2 justify-start items-start">
          <input
            ref={openFileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={handleOpenFileSelected}
          />
          {CHART_VARIANT_OPTIONS.map((option) => {
            const isActive = option.value === chartVariant;
            const baseClasses = "px-3 py-2 text-left min-w-[160px] leading-tight";
            const inactiveClasses = "border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40";
            const activeClasses = `${BUTTON_PRIMARY} cursor-default`;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setChartVariant(option.value)}
                className={`${baseClasses} ${isActive ? activeClasses : inactiveClasses}`}
                disabled={isActive}
                aria-pressed={isActive}
              >
                <div className="text-sm font-semibold">{option.title}</div>
                <div className={`text-xs ${isActive ? "text-white/80" : "text-black/60"}`}>{option.subtitle}</div>
              </button>
            );
          })}
          <button
            type="button"
            className="px-3 py-1.5 text-sm border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40 disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={handleSaveToFile}
            disabled={!chart || !meta}
          >
            Сохранить в файл
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm border border-black bg-[#f1d6ae] text-black transition-colors hover:bg-[#edd7aa] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
            onClick={handleOpenFromFileClick}
          >
            Открыть файл
          </button>
        </div>
        <div className="text-sm" style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "6px 8px" }}>
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
            <div className="birth-panel" style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
              <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
                <tbody>
                <tr>
                  <td style={{ width: "50%", padding: "2px 4px" }}>Имя</td>
                  <td style={{ padding: "2px 4px" }}>Фамилия</td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                      value={personName}
                      onChange={(e) => setPersonName(e.target.value)}
                    />
                  </td>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
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
                        style={{ width: 70, background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                        value={birthParts.year}
                        onChange={(e) => {
                          if (e.target.value === "") return;
                          handlePartChange("year", parseInt(e.target.value, 10));
                        }}
                      />
                      <input
                        type="number"
                        style={{ width: 46, background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                        value={pad2(birthParts.month)}
                        onChange={(e) => {
                          if (e.target.value === "") return;
                          handlePartChange("month", parseInt(e.target.value, 10));
                        }}
                      />
                      <input
                        type="number"
                        style={{ width: 46, background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                        value={pad2(birthParts.day)}
                        onChange={(e) => {
                          if (e.target.value === "") return;
                          handlePartChange("day", parseInt(e.target.value, 10));
                        }}
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
                        style={{ width: 46, background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                        value={pad2(birthParts.hour)}
                        onChange={(e) => {
                          if (e.target.value === "") return;
                          handlePartChange("hour", parseInt(e.target.value, 10));
                        }}
                      />
                      <input
                        type="number"
                        style={{ width: 46, background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                        value={pad2(birthParts.minute)}
                        onChange={(e) => {
                          if (e.target.value === "") return;
                          handlePartChange("minute", parseInt(e.target.value, 10));
                        }}
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
	                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
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
                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
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
                          background: PAPER_BLOCK_BG,
                          border: "1px solid #000",
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
                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
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
                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
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
                    <input
                      style={{ width: "100%", background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
                      value={ianaTzDisplay}
                      readOnly
                    />
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
	                      style={{ width: 60, marginLeft: 8, background: BIRTH_FIELD_BG, border: "1px solid #000", padding: "2px 4px" }}
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
                    <div style={{ fontSize: 12, color: "#000" }}>
                      DST выставляется автоматически по истории тайм-зоны. Снимите галочку, если в этот период переход не применялся.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} style={{ padding: "6px 4px" }}>
                    <button
                      type="button"
                      className={`${BUTTON_PRIMARY} w-full`}
                      style={{ background: PAPER_BLOCK_BG, color: "#1f1309", border: "1px solid #000", fontWeight: 700 }}
                      onClick={() => buildNow(birthParts)}
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
        {chart ? (
          <div
            className="mt-6 space-y-4"
            style={{ margin: "20px auto 30px", paddingBottom: "30px", maxWidth: "1450px", width: "100%" }}
          >
            <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{ascSectionTitle}</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#000", marginBottom: 6 }}>
                {ascSignNameForText}
                {ascLongitudeTextForText
                  ? chartVariantConfig.longitudeLabel
                    ? ` - ${chartVariantConfig.longitudeLabel} ${ascLongitudeTextForText}`
                    : ` - ${ascLongitudeTextForText}`
                  : ""}
              </div>
              {ascDescription ? <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{ascDescription}</div> : null}
            </div>

            <div className="flex justify-center px-2" style={{ marginTop: "12px", marginBottom: "12px" }}>
              <button
                type="button"
                className={`${BUTTON_SECONDARY} rounded-xl px-4 py-3`}
                style={{
                  fontSize: "1.5rem",
                  width: "500px",
                  maxWidth: "100%",
                  marginBottom: "0px",
                  background: PAPER_BLOCK_BG,
                  color: "#1f1309",
                  border: "1px solid #000",
                  fontWeight: 700,
                }}
                onClick={handleFullDetailsClick}
              >
                {allowFullDetails ? "Скрыть полное описание" : "Полное описание карты"}
              </button>
            </div>

            {allowFullDetails && lagneshaDescription ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px", marginTop: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Лагнеша</strong>
                </div>
                {lagneshaHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{lagneshaHeading}</div> : null}
                {lagneshaBody ? <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{lagneshaBody}</div> : null}
              </div>
            ) : null}

            {allowFullDetails && lagneshaHouseDescription ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Лагнеша в доме</strong>
                </div>
                {lagneshaHouseHeading ? (
                  <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{lagneshaHouseHeading}</div>
                ) : null}
                {lagneshaHouseBody ? <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{lagneshaHouseBody}</div> : null}
              </div>
            ) : null}

            {allowFullDetails && atmaKarakaDescription ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Атма-карака</strong>
                </div>
                <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>
                  {atmaKarakaHeading}
                  {atmaKarakaPercent !== null ? ` - ${atmaKarakaPercent.toFixed(2)}%` : ""}
                  {atmaKarakaArcLabel ? ` (${atmaKarakaArcLabel})` : ""}
                </div>
                {atmaKarakaBody ? <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{atmaKarakaBody}</div> : null}
              </div>
            ) : null}

            {allowFullDetails && daraKarakaDescription ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Дара-карака</strong>
                </div>
                <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>
                  {daraKarakaHeading}
                  {daraKarakaPercent !== null ? ` - ${daraKarakaPercent.toFixed(2)}%` : ""}
                  {daraKarakaArcLabel ? ` (${daraKarakaArcLabel})` : ""}
                </div>
                {daraKarakaBody ? <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{daraKarakaBody}</div> : null}
              </div>
            ) : null}

            {allowFullDetails && showSunSection ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Солнце</strong>
                </div>
                {sunHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{sunHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{sunHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && showMoonSection ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Луна</strong>
                </div>
                {moonHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{moonHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{moonHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && jupiterHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Юпитер</strong>
                </div>
                {jupiterHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{jupiterHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{jupiterHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && mercuryHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Меркурий</strong>
                </div>
                {mercuryHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{mercuryHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{mercuryHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && venusHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Венера</strong>
                </div>
                {venusHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{venusHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{venusHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && saturnHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Сатурн</strong>
                </div>
                {saturnHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{saturnHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{saturnHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && marsHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Марс</strong>
                </div>
                {marsHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{marsHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{marsHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && rahuHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Раху</strong>
                </div>
                {rahuHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{rahuHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{rahuHouseBody}</div>
              </div>
            ) : null}

            {allowFullDetails && ketuHouseBody ? (
              <div style={{ background: PAPER_BLOCK_BG, border: "1px solid #000", padding: "10px 12px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                  <strong>Кету</strong>
                </div>
                {ketuHouseHeading ? <div style={{ fontSize: 16, color: "#000", marginBottom: 6 }}>{ketuHouseHeading}</div> : null}
                <div style={{ fontSize: 16, whiteSpace: "pre-line" }}>{ketuHouseBody}</div>
              </div>
            ) : null}
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
};

export default AdditionalChartPage;
