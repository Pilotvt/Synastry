import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import moment from "moment-timezone";
import tzLookup from "tz-lookup";
import { supabase } from "../lib/supabase";
import { saveChart } from "../lib/charts";
import { useProfile } from "../store/profile";
import { latinToRuName } from "../utils/transliterate";
import { loadChartTextResources, type ChartTextResources } from "../lib/textResources";
import NorthIndianChart from "../components/NorthIndianChart";
import { requestNewChartReset } from "../utils/newChartRequest";
import { readProfileFromStorage, writeProfileToStorage } from "../utils/profileStorage";
import { isOwnerMatch, clearProfileStorage } from "../utils/profileStorage";
import { readSavedChart, writeSavedChart, clearSavedChart, type SavedChartSource, type SavedChartMetadata } from "../utils/savedChartStorage";
import { isChartSessionFromFile, setChartSessionFromFile } from "../utils/fromFileSession";
import { encodeSupabasePointer, needsSupabaseResolution, parseSupabaseStoragePointer, resolveSupabaseScreenshotUrl } from "../utils/screenshotUrl";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";
import {
  PROFILE_SNAPSHOT_STORAGE_KEY,
  LAST_SAVED_CHART_FINGERPRINT_KEY,
  LAST_SAVED_PROFILE_FINGERPRINT_KEY,
} from "../constants/storageKeys";
// profile freshness handled locally to avoid cross-file type coupling

// Keys and constants
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";
const ENABLE_LICENSE_GATE = false; // Отключаем навязчивое окно лицензии — пользователь откроет его вручную

// Types (kept minimal and local to avoid cross-file collisions)
type ProfileSnapshot = {
  personName?: string;
  lastName?: string;
  birth?: string;
  gender?: "male" | "female";
  country?: string;
  cityQuery?: string;
  selectedCity?: string;
  cityId?: string;
  cityNameRu?: string;
  residenceCountry?: string;
  residenceCityName?: string;
  manual?: boolean;
  lat: number;
  lon: number;
  enableTzCorrection?: boolean;
  tzCorrectionHours?: number;
  dstManual?: boolean;
  dstManualOverride?: boolean;
  mainPhoto?: string | null;
  smallPhotos?: (string | null)[];
  typeazh?: string;
  familyStatus?: string;
  about?: string;
  interests?: string;
  career?: string;
  children?: string;
  updated_at?: number;
};

type ChartRequestPayload = {
  datetime_iso: string;
  latitude: number;
  longitude: number;
  elevation_m: number;
  house_system: string;
  constellational?: boolean;
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
  ascendant: { sign: string; degree: number; lon_sidereal: number; constellation_iau?: string; constellation_name_ru?: string };
  mc: { sign: string; degree: number; lon_sidereal: number; constellation_iau?: string; constellation_name_ru?: string };
  planets: {
    name: string;
    lon_sidereal: number;
    sign: string;
    house: number;
    nakshatra?: string | null;
    iau_constellation: string;
    is_retrograde: boolean;
    sidereal_speed: number;
    house_progress?: number;
    house_strength?: number;
  }[];
  houses: { house: number; sign: string }[];
  north_indian_layout: { boxes: NorthIndianBox[] };
  aspects: AspectLabel[];
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
  screenshotUrl?: string | null;
  screenshotHash?: string | null;
  screenshotStoragePointer?: string | null;
  debug_info: Record<string, unknown> | null;
};

type PlanetArcStat = {
  planet: string;
  percent: number;
  arcName: string;
  lon: number;
};

type BuildMeta = {
  ianaTz: string;
  datetimeIso: string;
  baseOffsetMinutes: number;
  finalOffsetMinutes: number;
  autoDstMinutes: number;
  manualDstMinutes: number;
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
    description: "Лунная карта. Первый дом — знак Луны, дома и трактовки пересчитаны относительно Луны. Описание самой Луны скрыто.",
    skipPlanet: "moon",
  },
  surya: {
    chartTitle: "СОЛНЕЧНАЯ КАРТА (SURYA)",
    ascTitle: "Созвездие в 1 доме (Солнце)",
    headerAscLabel: "Созвездие 1 дома (Солнце)",
    longitudeLabel: "Солнце",
    description: "Солнечная карта. Первый дом — знак Солнца, дома и трактовки пересчитаны относительно Солнца. Описание Солнца скрыто.",
    skipPlanet: "sun",
  },
};

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

type CloudSaveOptions = {
  silent?: boolean;
  skipIfUnchanged?: boolean;
  updateStatus?: (message: string | null) => void;
  notifyScreenshotUploading?: (uploading: boolean) => void;
};

type CloudSaveResult = {
  success: boolean;
  skipped?: boolean;
  chartId?: string | number;
  screenshotUploaded?: boolean;
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

type JsonRecord = Record<string, unknown>;

const EMPTY_SMALL_PHOTOS: (string | null)[] = [null, null];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function normalizeSmallPhotos(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) return [...EMPTY_SMALL_PHOTOS];
  const normalized = value.slice(0, 2).map((item) => (typeof item === "string" ? item : null));
  while (normalized.length < 2) normalized.push(null);
  return normalized;
}

function personFingerprint(p: ProfileSnapshot | null | undefined): string {
  if (!p) return "";
  const name = (p.personName ?? "").trim().toLowerCase();
  const last = (p.lastName ?? "").trim().toLowerCase();
  const birth = (p.birth ?? "").trim();
  const city = (p.selectedCity ?? p.cityQuery ?? "").trim().toLowerCase();
  const cityId = typeof p?.cityId === 'string' ? p.cityId.trim() : '';
  const latValue = typeof p.lat === 'number' && Number.isFinite(p.lat) ? p.lat.toFixed(4) : '';
  const lonValue = typeof p.lon === 'number' && Number.isFinite(p.lon) ? p.lon.toFixed(4) : '';
  return [name, last, birth, cityId || city, latValue, lonValue].join('|');
}

function hasFingerprintableCore(profile: ProfileSnapshot | null | undefined): profile is ProfileSnapshot {
  if (!profile) return false;
  if (typeof profile.birth !== 'string' || !profile.birth.trim()) return false;
  const lat = (profile as { lat?: number }).lat;
  const lon = (profile as { lon?: number }).lon;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return false;
  if (typeof lon !== 'number' || !Number.isFinite(lon)) return false;
  return true;
}

function extractAscSignFromChart(chartValue: unknown): string | null {
  if (!isRecord(chartValue)) return null;

  // Try ascendant.sign first
  const ascValue = (chartValue as Record<string, unknown>).ascendant;
  if (isRecord(ascValue) && typeof ascValue.sign === "string") {
    return SIGN_INFO[ascValue.sign]?.ru ?? ascValue.sign;
  }

  // Fallback: find house 1 sign
  const housesValue = (chartValue as Record<string, unknown>).houses;
  if (Array.isArray(housesValue)) {
    for (const house of housesValue) {
      if (!isRecord(house)) continue;
      const houseNumber = typeof house.house === "number" ? house.house : Number(house.house);
      const signCode = typeof house.sign === "string" ? house.sign : "";
      if (houseNumber === 1 && signCode) {
        return SIGN_INFO[signCode]?.ru ?? signCode;
      }
    }
  }

  return null;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const content = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",");
  return `{${content}}`;
}

function sanitizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFingerprint(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "debug_info") continue;
      result[key] = sanitizeForFingerprint(val);
    }
    return result;
  }
  return value;
}

function computeChartFingerprint(chart: ChartResponse | null, meta: BuildMeta | null): string | null {
  if (!chart && !meta) return null;
  const payload: Record<string, unknown> = {};
  if (chart) payload.chart = sanitizeForFingerprint(chart);
  if (meta) payload.meta = sanitizeForFingerprint(meta);
  return stableStringify(payload);
}

function needsCloudScreenshot(chart: ChartResponse | null): boolean {
  if (!chart) return false;
  const url = typeof chart.screenshotUrl === 'string' ? chart.screenshotUrl : '';
  if (!url) return true;
  return url.startsWith('data:') || url.startsWith('blob:');
}

function computeScreenshotTaskKey(chart: ChartResponse | null, forceToken = 0): string | null {
  if (!chart) return null;
  const shouldForce = forceToken > 0;
  if (!shouldForce && !needsCloudScreenshot(chart)) return null;
  const rest = { ...(chart as ChartResponse & JsonRecord) };
  delete rest.screenshotUrl;
  delete rest.screenshotHash;
  const payload = stableStringify(sanitizeForFingerprint(rest));
  return shouldForce ? `${forceToken}:${payload}` : payload;
}

function writeLastSavedFingerprint(fingerprint: string | null): void {
  try {
    if (!fingerprint) {
      localStorage.removeItem(LAST_SAVED_PROFILE_FINGERPRINT_KEY);
    } else {
      localStorage.setItem(LAST_SAVED_PROFILE_FINGERPRINT_KEY, fingerprint);
    }
  } catch (error) {
    console.warn('Failed to persist profile fingerprint', error);
  }
}

function readLastSavedChartFingerprint(): string | null {
  try {
    return localStorage.getItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
  } catch (error) {
    console.warn('Failed to read last saved chart fingerprint', error);
    return null;
  }
}

function writeLastSavedChartFingerprint(fingerprint: string | null): void {
  try {
    if (!fingerprint) {
      localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
    } else {
      localStorage.setItem(LAST_SAVED_CHART_FINGERPRINT_KEY, fingerprint);
    }
  } catch (error) {
    console.warn('Failed to persist chart fingerprint', error);
  }
}

type ProfileTextField = "typeazh" | "familyStatus" | "about" | "interests" | "career" | "children";

const PROFILE_TEXT_FIELDS: ProfileTextField[] = ["typeazh", "familyStatus", "about", "interests", "career", "children"];

function updateSavedChartLocalStorage(
  ownerId: string | null,
  updater: (payload: JsonRecord) => JsonRecord,
  metaOverride?: Partial<SavedChartMetadata>,
): void {
  try {
    const record = readSavedChart<JsonRecord>(ownerId ?? null);
    if (!record && !ownerId) return;
    const base = record && isRecord(record.payload) ? { ...(record.payload as JsonRecord) } : {};
    const next = updater(base);
    const existingMeta = record?.meta ?? null;
    const nextMeta: Partial<SavedChartMetadata> = {
      source: metaOverride?.source ?? existingMeta?.source ?? 'local',
      fingerprint:
        metaOverride?.fingerprint === null
          ? null
          : metaOverride?.fingerprint ?? existingMeta?.fingerprint ?? null,
      updatedAt: metaOverride?.updatedAt ?? Date.now(),
    };
    writeSavedChart(next, ownerId ?? null, { meta: nextMeta });
  } catch (error) {
    console.warn('Failed to update saved chart in localStorage', error);
  }
}

function mergeChartWithScreenshot(
  chartValue: unknown,
  screenshotUrl: string,
  screenshotHash?: string | null,
  storagePointer?: string | null,
): JsonRecord {
  const chartRecord = isRecord(chartValue) ? { ...chartValue } : {};
  chartRecord.screenshotUrl = screenshotUrl;
  if (typeof screenshotHash === 'string' && screenshotHash.trim()) {
    chartRecord.screenshotHash = screenshotHash.trim();
  }
  if (storagePointer && typeof storagePointer === 'string') {
    chartRecord.screenshotStoragePointer = storagePointer;
  }
  return chartRecord;
}

async function computeBlobSha256(blob: Blob): Promise<string | null> {
  try {
    const buffer = await blob.arrayBuffer();
    const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (!cryptoApi?.subtle) {
      return null;
    }
    const hashBuffer = await cryptoApi.subtle.digest('SHA-256', buffer);
    const bytes = Array.from(new Uint8Array(hashBuffer));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    console.warn('Не удалось вычислить хеш скриншота', error);
    return null;
  }
}

function toJsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function getObjectURLFactory(): typeof URL {
  const win = window as typeof window & { webkitURL?: typeof URL };
  return win.URL ?? win.webkitURL ?? URL;
}

function rotateHouseNumber(house: number | null | undefined, shift: number): number | null {
  if (typeof house !== 'number' || !Number.isFinite(house)) return null;
  const normalized = ((house - 1 - shift) % 12 + 12) % 12;
  return normalized + 1;
}

function isBuildMeta(value: unknown): value is BuildMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.ianaTz === "string" &&
    typeof value.datetimeIso === "string" &&
    typeof value.baseOffsetMinutes === "number" &&
    typeof value.finalOffsetMinutes === "number" &&
    typeof value.autoDstMinutes === "number" &&
    typeof value.manualDstMinutes === "number"
  );
}

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

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60)
    .toString()
    .padStart(2, "0");
  const mins = (abs % 60).toString().padStart(2, "0");
  return `${sign}${hours}:${mins}`;
}

function formatDegrees(value: number): string {
  const normalized = ((value % 360) + 360) % 360;
  let deg = Math.floor(normalized);
  const minutesFloat = (normalized - deg) * 60;
  let minutes = Math.floor(minutesFloat);
  let seconds = Math.round((minutesFloat - minutes) * 60);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    deg = (deg + 1) % 360;
  }
  return `${deg}\u00B0 ${minutes.toString().padStart(2, "0")}' ${seconds.toString().padStart(2, "0")}"`;
}

function formatDegreesWithoutSeconds(value: number): string {
  const normalized = ((value % 360) + 360) % 360;
  const deg = Math.floor(normalized);
  const minutes = Math.floor((normalized - deg) * 60);
  return `${deg}\u00B0 ${minutes.toString().padStart(2, "0")}'`;
}

function splitDescription(text: string): { heading: string; body: string } {
  if (!text) return { heading: "", body: "" };
  const parts = text.split("\n");
  const heading = (parts.shift() ?? "").trim();
  const body = parts.join("\n").trim();
  if (!body) {
    return { heading: "", body: heading };
  }
  return { heading, body };
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

function extractProfileSnapshot(data: unknown): ProfileSnapshot | null {
  if (!data || typeof data !== "object") return null;
  const maybeObj = data as Record<string, unknown>;
  const profile = maybeObj.profile;
  if (profile && typeof profile === "object") {
    const snapshot = profile as ProfileSnapshot;
    if ((!snapshot.cityNameRu || !snapshot.cityNameRu.trim()) && typeof snapshot.selectedCity === "string") {
      snapshot.cityNameRu = latinToRuName(snapshot.selectedCity);
    }
    return snapshot;
  }
  const fallback = data as ProfileSnapshot;
  if ((!fallback.cityNameRu || !fallback.cityNameRu.trim()) && typeof fallback.selectedCity === "string") {
    fallback.cityNameRu = latinToRuName(fallback.selectedCity);
  }
  return fallback;
}

function ensureProfileLocalization(snapshot: ProfileSnapshot | null): ProfileSnapshot | null {
  if (!snapshot) return null;
  if ((!snapshot.cityNameRu || !snapshot.cityNameRu.trim()) && typeof snapshot.selectedCity === "string") {
    snapshot = { ...snapshot, cityNameRu: latinToRuName(snapshot.selectedCity) };
  }
  return snapshot;
}

type MergeSnapshotOptions = {
  preferProvided?: boolean;
};

function mergeWithLocalSnapshot(
  snapshot: ProfileSnapshot | null,
  options?: MergeSnapshotOptions,
  ownerId?: string | null,
): ProfileSnapshot | null {
  const providedSnapshot = snapshot ? { ...snapshot } : null;
  const preferProvided = Boolean(options?.preferProvided && providedSnapshot);
  let localSnapshot: ProfileSnapshot | null = null;

  if (!preferProvided || !providedSnapshot) {
    try {
      const stored = readProfileFromStorage<ProfileSnapshot | Record<string, unknown>>(PROFILE_SNAPSHOT_STORAGE_KEY);
      if (stored && isOwnerMatch(stored.ownerId, ownerId)) {
        localSnapshot = extractProfileSnapshot(stored.profile);
      }
    } catch (err) {
      console.warn("Unable to read local profile snapshot during initialization", err);
    }
  }

  const storedFingerprint = hasFingerprintableCore(localSnapshot)
    ? personFingerprint(localSnapshot)
    : null;

  let result: ProfileSnapshot | null = null;
  if (preferProvided) {
    result = providedSnapshot ? { ...providedSnapshot } : null;
  } else if (localSnapshot) {
    result = { ...localSnapshot };
  } else if (providedSnapshot) {
    result = { ...providedSnapshot };
  }
  if (!result) return null;

  if (providedSnapshot && !preferProvided) {
    // Merge provided onto local with field-level rules to avoid wiping local data with empties
    const pickNonEmpty = (a?: string, b?: string) => (b && b.trim() ? b : (a ?? ""));
    const textFields = PROFILE_TEXT_FIELDS as ReadonlyArray<keyof ProfileSnapshot>;

    // Photos
    const providedMain = typeof providedSnapshot.mainPhoto === 'string' ? providedSnapshot.mainPhoto : null;
    const localMain = typeof result.mainPhoto === 'string' ? result.mainPhoto : null;
    result.mainPhoto = providedMain || localMain || null;

    const providedSmall = normalizeSmallPhotos(providedSnapshot.smallPhotos);
    const localSmall = normalizeSmallPhotos(result.smallPhotos);
    const providedHasAny = providedSmall.some((v) => typeof v === 'string' && v);
    result.smallPhotos = providedHasAny ? providedSmall : localSmall;

    // Core fields: prefer provided if defined, else keep local
    const target = result as Record<keyof ProfileSnapshot, ProfileSnapshot[keyof ProfileSnapshot]>;
    const providedRecord = providedSnapshot as Record<keyof ProfileSnapshot, ProfileSnapshot[keyof ProfileSnapshot]>;

    const simpleFields: Array<keyof ProfileSnapshot> = [
      'personName','lastName','birth','gender','country','cityQuery','selectedCity','cityId','cityNameRu','manual',
      'lat','lon','enableTzCorrection','tzCorrectionHours','dstManual','dstManualOverride',
      'residenceCountry','residenceCityName'
    ];
    for (const key of simpleFields) {
      const providedVal = providedRecord[key];
      if (providedVal !== undefined && providedVal !== null && providedVal !== '') {
        target[key] = providedVal;
      }
    }

    for (const field of textFields) {
      const localVal = typeof target[field] === 'string' ? (target[field] as string) : '';
      const providedVal = typeof providedRecord[field] === 'string' ? (providedRecord[field] as string) : '';
      target[field] = pickNonEmpty(localVal, providedVal) as ProfileSnapshot[keyof ProfileSnapshot];
    }
  }

  const resultFingerprint = hasFingerprintableCore(result)
    ? personFingerprint(result)
    : null;
  const personChanged = Boolean(
    storedFingerprint &&
    resultFingerprint &&
    storedFingerprint !== resultFingerprint,
  );
  if (personChanged) {
    result.residenceCountry = undefined;
    result.residenceCityName = '';
  }

  // Normalize fallbacks
  if (!Array.isArray(result.smallPhotos)) {
    result.smallPhotos = [...EMPTY_SMALL_PHOTOS];
  } else if (result.smallPhotos.length < 2) {
    result.smallPhotos = normalizeSmallPhotos(result.smallPhotos);
  }
  if (result.mainPhoto === undefined) result.mainPhoto = null;
  if (result.typeazh === undefined) result.typeazh = "";
  if (result.familyStatus === undefined) result.familyStatus = "";
  if (result.about === undefined) result.about = "";
  if (result.interests === undefined) result.interests = "";
  if (result.career === undefined) result.career = "";
  if (result.children === undefined) result.children = "";
  return result;
}

function persistProfileSnapshotLocal(profile: ProfileSnapshot | null, ownerId?: string | null) {
  if (!profile) return;
  try {
    const sanitized: ProfileSnapshot = { ...profile };
    if (!Array.isArray(sanitized.smallPhotos)) {
      sanitized.smallPhotos = [null, null];
    } else {
      const normalized = sanitized.smallPhotos.slice(0, 2);
      while (normalized.length < 2) normalized.push(null);
      sanitized.smallPhotos = normalized;
    }
    sanitized.mainPhoto = sanitized.mainPhoto ?? null;
    sanitized.smallPhotos = sanitized.smallPhotos ?? [null, null];
    if (sanitized.smallPhotos.length < 2) {
      const normalized = sanitized.smallPhotos.slice(0, 2);
      while (normalized.length < 2) normalized.push(null);
      sanitized.smallPhotos = normalized;
    }
    sanitized.typeazh = sanitized.typeazh ?? "";
    sanitized.familyStatus = sanitized.familyStatus ?? "";
    sanitized.about = sanitized.about ?? "";
    sanitized.interests = sanitized.interests ?? "";
    sanitized.career = sanitized.career ?? "";
    sanitized.children = sanitized.children ?? "";
    writeProfileToStorage(PROFILE_SNAPSHOT_STORAGE_KEY, sanitized, ownerId ?? null, false);
  } catch (err) {
    console.warn("Unable to persist profile data snapshot during initialization", err);
  }
}

function normalizeBirthForParsing(rawBirth: string | undefined | null): string | null {
  if (!rawBirth) return null;
  let value = String(rawBirth).trim();
  if (!value) return null;
  value = value.replace(/;\s*/g, "");
  value = value.replace(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");
  value = value.replace(/(\d{4}-\d{2}-\d{2})T\s+(\d{2}:\d{2})/, "$1T$2");
  return value;
}

function isCompleteChart(data: unknown): data is ChartResponse {
  if (!data || typeof data !== "object") return false;
  const chart = data as ChartResponse;
  if (!Array.isArray(chart.planets) || chart.planets.length === 0) return false;
  if (!chart.ascendant) return false;
  if (!chart.north_indian_layout || !Array.isArray(chart.north_indian_layout.boxes) || chart.north_indian_layout.boxes.length === 0) {
    return false;
  }
  return true;
}

function buildFallbackMeta(profile: ProfileSnapshot | null): BuildMeta {
  // Best-effort fallback when opening a chart from file without meta
  const datetimeIso = (() => {
    const raw = profile?.birth;
    if (typeof raw === 'string' && raw.trim()) {
      const norm = normalizeBirthForParsing(raw);
      if (norm) return norm;
    }
    try { return new Date().toISOString(); } catch { return '1970-01-01T00:00:00Z'; }
  })();
  return {
    ianaTz: 'local',
    datetimeIso,
    baseOffsetMinutes: 0,
    finalOffsetMinutes: 0,
    autoDstMinutes: 0,
    manualDstMinutes: 0,
  };
}

// Helper: pick freshest profile by updated_at (missing treated as 0)
function pickFreshProfile(...profiles: Array<ProfileSnapshot | null | undefined>): ProfileSnapshot | null {
  let best: ProfileSnapshot | null = null;
  let bestTime = -1;
  for (const p of profiles) {
    if (!p) continue;
    if (!hasFingerprintableCore(p)) continue;
    const t = typeof p.updated_at === 'number' ? p.updated_at : 0;
    if (t > bestTime) {
      best = p;
      bestTime = t;
    }
  }
  return best;
}

function buildChartPayload(profile: ProfileSnapshot):
  | { ok: true; request: ChartRequestPayload; meta: BuildMeta }
  | { ok: false, error: string } {
  const normalizedBirth = normalizeBirthForParsing(profile.birth);
  if (!normalizedBirth) {
    return { ok: false, error: "Не заполнена дата и время рождения." };
  }

  if (!Number.isFinite(profile.lat) || !Number.isFinite(profile.lon)) {
    return { ok: false, error: "Не заданы координаты места рождения." };
  }

  let ianaTz: string;
  try {
    ianaTz = tzLookup(profile.lat, profile.lon);
  } catch (err) {
    console.error("Не удалось определить IANA-часовой пояс", err);
    return { ok: false, error: "Не удалось определить часовой пояс для указанных координат." };
  }

  // Parse birth input robustly:
  // - If profile.birth already contains an explicit offset or 'Z', parse with parseZone
  // - Otherwise parse as local time in the discovered IANA timezone
  const hasExplicitOffset = /([Zz]|[+-]\d{2}:?\d{2})$/.test(normalizedBirth);
  const birthMoment = hasExplicitOffset
    ? moment.parseZone(normalizedBirth).tz(ianaTz)
    : moment.tz(normalizedBirth, "YYYY-MM-DDTHH:mm", ianaTz);
  if (!birthMoment.isValid()) {
    return { ok: false, error: "Некорректный формат даты или времени рождения." };
  }

  const baseOffsetMinutes = birthMoment.utcOffset();
  const autoDstMinutes = birthMoment.isDST() ? 60 : 0;
  const manualDstMinutes = profile.dstManual ? 60 : 0;
  const correctionMinutes = profile.enableTzCorrection ? (Number.isFinite(profile.tzCorrectionHours ?? 0) ? (profile.tzCorrectionHours ?? 0) * 60 : 0) : 0;

  const finalOffsetMinutes = baseOffsetMinutes + (profile.enableTzCorrection ? correctionMinutes + (manualDstMinutes - autoDstMinutes) : 0);

  // Apply manual time corrections by shifting the instant in time (add minutes).
  // Using utcOffset(..., true) previously kept the same local clock and changed UTC,
  // which produced incorrect instants (wrong UTC/ascendant). Instead we shift the
  // moment by the delta so the final UTC is correct for the requested correction.
  const deltaMinutes = finalOffsetMinutes - baseOffsetMinutes;
  const adjustedMoment = birthMoment.clone().add(deltaMinutes, "minutes");
  const datetimeIso = adjustedMoment.format("YYYY-MM-DDTHH:mm:ssZ");

    const req: ChartRequestPayload & { constellational?: boolean } = {
      datetime_iso: datetimeIso,
      latitude: profile.lat,
      longitude: profile.lon,
      elevation_m: 0,
      house_system: "porphyry",
      constellational: true,
    };
    // No ayanamsha/node_type fields are sent anymore (J2000/IAU only)

    return {
      ok: true,
      request: req,
      meta: {
        ianaTz,
        datetimeIso,
        baseOffsetMinutes,
        finalOffsetMinutes,
        autoDstMinutes,
        manualDstMinutes,
      },
    };
}

function QuestionnaireButton({ profile, chart, meta, navigate, fromFile, ownerId }: {
  profile: ProfileSnapshot | null;
  chart: ChartResponse | null;
  meta: BuildMeta | null;
  navigate: (to: string) => void;
  fromFile?: boolean;
  ownerId?: string | null;
}) {
  const { profile: globalProfile } = useProfile();

  async function handleClick() {
    // Navigate instantly without blocking on cloud saves
    try {
      const stamped: ProfileSnapshot = {
        ...(profile ?? {}),
        gender: profile?.gender ?? globalProfile.gender,
        updated_at: Date.now(),
      } as ProfileSnapshot;

      try {
        const payloadToSave = { profile: stamped, chart: chart ?? null, meta: meta ?? null };
        const sourceForSave: SavedChartSource = fromFile ? 'file' : 'local';
        writeSavedChart(payloadToSave, ownerId ?? null, {
          meta: {
            source: sourceForSave,
            updatedAt: Date.now(),
            fingerprint: null,
          },
        });
        writeProfileToStorage(PROFILE_SNAPSHOT_STORAGE_KEY, stamped, ownerId ?? null, false);
      } catch (storageErr) {
        console.warn('Failed to write saved chart/profile to localStorage before questionnaire:', storageErr);
      }

      navigate(fromFile ? '/questionnaire?fromFile=1' : '/questionnaire');
    } catch (e) {
      console.warn('Navigation to questionnaire encountered an issue:', e);
      navigate('/questionnaire');
    }
  }

  return (
    <button
      type="button"
      className={`${BUTTON_SECONDARY} px-4 py-2 text-sm`}
      onClick={handleClick}
    >
      Изменить анкету
    </button>
  );
}

const ChartPage = () => {
  const [licenseChecked, setLicenseChecked] = useState(false);
  const [licenseAllowed, setLicenseAllowed] = useState(true);
  const [licenseStatus, setLicenseStatus] = useState<ElectronLicenseStatus | null>(null);
  // Detailed content gating: licensed users see full details; trial can unlock via button
  const isLicensed = Boolean(licenseStatus?.licensed);
  const [fullDetailsUnlocked, setFullDetailsUnlocked] = useState<boolean>(false);
  const allowFull = isLicensed || fullDetailsUnlocked;
  const loadedFromFileRef = useRef(false);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const saveInFlightRef = useRef(false);
  const autoSavePendingRef = useRef(false);
  const fileAutoSaveRef = useRef(false);
  const autoSaveFingerprintRef = useRef<string | null>(null);
  const lastUserIdRef = useRef<string | null>(null);
  const newChartButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    newChartButtonRef.current?.blur();
  }, []);
  const lastScreenshotUploadRef = useRef<{ location: 'local' | 'cloud'; bucket?: string } | null>(null);
  const navigate = useNavigate();
  const { profile: storeProfile, setProfile: setGlobalProfile } = useProfile();
  const location = useLocation();
  const params = new URLSearchParams(location.search || "");
  type CacheClearOptions = {
    clearProfile?: boolean;
  };

  const clearLocalChartCaches = useCallback((options?: CacheClearOptions) => {
    try {
      clearSavedChart();
    } catch (error) {
      console.warn('Failed to clear saved chart cache', error);
    }
    writeLastSavedFingerprint(null);
    writeLastSavedChartFingerprint(null);
    if (options?.clearProfile === false) {
      return;
    }
    try {
      clearProfileStorage(PROFILE_SNAPSHOT_STORAGE_KEY);
    } catch (error) {
      console.warn('Failed to clear profile snapshot cache', error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const api = (typeof window !== 'undefined') ? window.electronAPI?.license : undefined;
        const status = await api?.getStatus?.();
        if (cancelled) return;
        if (status) setLicenseStatus(status);
        // Fail-open: если статуса нет (web/dev), не блокируем
        const allowed = status == null
          ? true
          : Boolean(status.allowed || status.licensed || (status.trial && typeof status.trial.daysLeft === 'number' && status.trial.daysLeft > 0));
        setLicenseAllowed(allowed);
      } finally {
        if (!cancelled) setLicenseChecked(true);
      }
    }
    check();
    const unsub = (typeof window !== 'undefined') ? window.electronAPI?.license?.onStatus?.((s) => {
      setLicenseStatus(s);
      const allowed = s == null
        ? true
        : Boolean(s.allowed || s.licensed || (s.trial && typeof s.trial.daysLeft === 'number' && s.trial.daysLeft > 0));
      setLicenseAllowed(allowed);
    }) : undefined;
    return () => { cancelled = true; unsub?.(); };
  }, []);

  // Auto-open license prompt when access is not allowed (only on this page)
  const promptShownRef = useRef(false);
  useEffect(() => {
    if (!ENABLE_LICENSE_GATE) return;
    if (!licenseChecked) return;
    if (licenseAllowed) return;
    if (promptShownRef.current) return;
    promptShownRef.current = true;
    try {
      // Small delay so overlay is painted before prompt steals focus
      setTimeout(() => { window.electronAPI?.license?.requestPrompt?.(); }, 150);
    } catch (promptError) {
      console.warn('Auto license prompt failed to open', promptError);
    }
  }, [licenseChecked, licenseAllowed]);
  const forceRefresh = params.get('forceRefresh');
  const fromFile = params.get('fromFile') === '1';
  const skipLocalCache = Boolean(forceRefresh) && !fromFile;

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | undefined;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!cancelled) {
          setCurrentUserId(data?.session?.user?.id ?? null);
        }
      } catch {
        if (!cancelled) setCurrentUserId(null);
      }
    })();

    try {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!cancelled) {
          setCurrentUserId(session?.user?.id ?? null);
        }
      });
      subscription = data?.subscription;
    } catch (subscriptionError) {
      console.warn('Failed to subscribe to auth state changes', subscriptionError);
    }

    return () => {
      cancelled = true;
      try {
        subscription?.unsubscribe();
      } catch (unsubscribeError) {
        console.warn('Failed to unsubscribe from auth state changes', unsubscribeError);
      }
    };
  }, []);

  const licenseGate = ENABLE_LICENSE_GATE
    ? (
      <div className="fixed inset-0 z-[1000] bg-white text-black flex items-center justify-center p-6" style={{ display: (!licenseChecked || !licenseAllowed) ? 'flex' : 'none' }}>
        <div className="max-w-md text-center">
          <h2 className="text-xl font-semibold mb-2">Требуется лицензия</h2>
          <p className="text-sm mb-4">Доступ к странице расчёта доступен только при активной лицензии.</p>
          {licenseStatus?.trial?.daysLeft !== undefined && (
            <div className="text-xs text-gray-600 mb-2">Пробная версия: осталось {Math.max(0, licenseStatus.trial.daysLeft)} дн.{licenseStatus.trial.expiresAt ? ` · до ${licenseStatus.trial.expiresAt}` : ''}</div>
          )}
          {licenseStatus?.licenseExpiresAt && (
            <div className="text-xs text-gray-600 mb-2">Срок лицензии: до {licenseStatus.licenseExpiresAt}</div>
          )}
          <div className="flex items-center justify-center gap-2">
            <button className="px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-sm" onClick={() => { try { window.electronAPI?.license?.requestPrompt?.(); } catch (promptError) { console.warn('Failed to open license prompt from overlay', promptError); } }}>Ввести ключ</button>
            <button className="px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-sm" onClick={() => { if (typeof window !== 'undefined') { window.location.href = 'mailto:pilot.vt@mail.ru'; } }}>Написать письмо</button>
          </div>
        </div>
      </div>
    )
    : null;
  const [loadedFromFile, setLoadedFromFile] = useState(false);
  const [chartSource, setChartSource] = useState<SavedChartSource | null>(null);
  useEffect(() => {
    const sessionActive = isChartSessionFromFile();
    const shouldFlag = Boolean(fromFile || loadedFromFile || chartSource === 'file' || sessionActive);
    setChartSessionFromFile(shouldFlag);
  }, [fromFile, loadedFromFile, chartSource]);
  useEffect(() => {
    if (!fromFile) return;
    lastLoadedFingerprintRef.current = null;
    autoSaveFingerprintRef.current = null;
    initialLoadCompleteRef.current = false;
  }, [fromFile]);

  useEffect(() => {
    if (!skipLocalCache) return;
    clearLocalChartCaches({ clearProfile: false });
    lastLoadedFingerprintRef.current = null;
    autoSaveFingerprintRef.current = null;
    initialLoadCompleteRef.current = false;
  }, [skipLocalCache, clearLocalChartCaches]);
  const [profile, setProfile] = useState<ProfileSnapshot | null>(null);
  const lastLoadedFingerprintRef = useRef<string | null>(null);
  const initialLoadCompleteRef = useRef(false);
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const chartLatestRef = useRef<ChartResponse | null>(null);
  useEffect(() => {
    chartLatestRef.current = chart;
  }, [chart]);
  useEffect(() => {
    let cancelled = false;
    const pointer = chart?.screenshotStoragePointer;
    const source = pointer ?? chart?.screenshotUrl ?? null;
    if (!source || source.startsWith('data:') || source.startsWith('blob:')) {
      return undefined;
    }
    if (!needsSupabaseResolution(source)) {
      return undefined;
    }
    (async () => {
      const resolved = await resolveSupabaseScreenshotUrl(pointer ?? source);
      if (!cancelled && resolved) {
        setChartScreenshot(resolved);
      }
    })().catch((err) => {
      console.warn('Failed to resolve chart screenshot URL', err);
    });
    return () => {
      cancelled = true;
    };
  }, [chart?.screenshotStoragePointer, chart?.screenshotUrl]);
  const [chartScreenshot, setChartScreenshot] = useState<string | null>(null);
  const [chartScreenshotHash, setChartScreenshotHash] = useState<string | null>(null);
  const [screenshotForceCounter, setScreenshotForceCounter] = useState(0);
  const screenshotTaskKey = useMemo(
    () => computeScreenshotTaskKey(chart, screenshotForceCounter),
    [chart, screenshotForceCounter],
  );
  const [screenshotStatus, setScreenshotStatus] = useState<string | null>(null);
  const requestScreenshotRefresh = useCallback(() => {
    setChartScreenshot(null);
    setChartScreenshotHash(null);
    setScreenshotStatus(null);
    lastScreenshotUploadRef.current = null;
    setScreenshotForceCounter((value) => value + 1);
  }, []);
  const screenshotPhaseRef = useRef<'idle' | 'capturing' | 'uploading' | 'ready'>('idle');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [meta, setMeta] = useState<BuildMeta | null>(null);
  const [chartVariant, setChartVariant] = useState<ChartVariant>("rashi");
  const chartVariantConfig = CHART_VARIANT_CONFIG[chartVariant];
  const [chartTextResources, setChartTextResources] = useState<ChartTextResources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ percent: number; message: string }>({
    percent: 0,
    message: "Подготовка...",
  });

  useEffect(() => {
    if (!currentUserId) {
      lastUserIdRef.current = null;
      return;
    }
    if (lastUserIdRef.current && lastUserIdRef.current !== currentUserId) {
      clearLocalChartCaches();
      lastLoadedFingerprintRef.current = null;
      autoSaveFingerprintRef.current = null;
      autoSavePendingRef.current = false;
      loadedFromFileRef.current = false;
      setProfile(null);
      setChart(null);
      setMeta(null);
      setChartScreenshot(null);
      setChartScreenshotHash(null);
      setScreenshotStatus(null);
      lastScreenshotUploadRef.current = null;
      setChartScreenshotHash(null);
      setScreenshotStatus(null);
      setLoadedFromFile(false);
      initialLoadCompleteRef.current = false;
    }
    lastUserIdRef.current = currentUserId;
  }, [currentUserId, clearLocalChartCaches]);

  useEffect(() => {
    let isActive = true;
    loadChartTextResources()
      .then((resources) => {
        if (!isActive) return;
        setChartTextResources((prev) => (prev ?? resources));
      })
      .catch((err) => {
        if (import.meta.env.DEV) {
          console.error("Failed to load chart text resources", err);
        }
      });
    return () => {
      isActive = false;
    };
  }, []);

  const captureChartImage = useCallback(async (): Promise<string | null> => {
    const container = chartContainerRef.current;
    if (!container) return null;
    const svgElement = container.querySelector('svg');
    if (!svgElement) return null;

    try {
      const serializer = new XMLSerializer();
      let svgStr = serializer.serializeToString(svgElement as SVGElement);
      if (!svgStr.includes('xmlns="http://www.w3.org/2000/svg"')) {
        svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const urlFactory = getObjectURLFactory();
      const blobUrl = urlFactory.createObjectURL(blob);
      const cleanup = () => {
        try { urlFactory.revokeObjectURL(blobUrl); } catch { /* ignore */ }
      };

      const dataUrl = await new Promise<string | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const svgGraphics = svgElement as SVGGraphicsElement;
            let width = 0;
            let height = 0;
            try {
              const bbox = svgGraphics.getBBox ? svgGraphics.getBBox() : null;
              if (bbox && bbox.width > 1 && bbox.height > 1) {
                width = Math.ceil(bbox.width);
                height = Math.ceil(bbox.height);
              }
            } catch {
              // ignore bbox failures and fallback to client metrics
            }
            if (!width || !height) {
              let rect: DOMRect | null = null;
              try {
                rect = (svgGraphics as Element).getBoundingClientRect();
              } catch {
                rect = null;
              }
              if (rect && rect.width > 1 && rect.height > 1) {
                width = Math.ceil(rect.width);
                height = Math.ceil(rect.height);
              }
            }
            if (!width || !height) {
              const svgWithBox = svgGraphics as SVGGraphicsElement & { clientWidth?: number; clientHeight?: number };
              width = svgWithBox.clientWidth ?? 600;
              height = svgWithBox.clientHeight ?? 400;
            }
            width = Math.max(1, width);
            height = Math.max(1, height);

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(null);
              return;
            }
            ctx.fillStyle = '#0b1220';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
          } catch (err) {
            console.warn('Failed to render chart screenshot', err);
            resolve(null);
          } finally {
            cleanup();
          }
        };
        img.onerror = () => {
          cleanup();
          resolve(null);
        };
        img.src = blobUrl;
      });

      return dataUrl;
    } catch (error) {
      console.warn('Failed to capture chart screenshot', error);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (skipLocalCache) {
      clearLocalChartCaches({ clearProfile: false });
      lastLoadedFingerprintRef.current = null;
      loadedFromFileRef.current = false;
    }
    if (loadedFromFileRef.current && !fromFile && !skipLocalCache) return;
    if (!skipLocalCache && (profile || chart || meta)) return;

    const activeProfile = typeof window !== 'undefined'
      ? (typeof useProfile.getState === 'function'
        ? useProfile.getState().profile
        : storeProfile)
      : null;
    // Convert Profile to ProfileSnapshot for fingerprinting
    const activeProfileSnapshot: ProfileSnapshot | null = activeProfile
      ? {
          personName: activeProfile.firstName,
          lastName: activeProfile.lastName,
          birth: activeProfile.birth,
          gender: activeProfile.gender,
          country: activeProfile.country,
          selectedCity: activeProfile.cityName,
          cityNameRu: activeProfile.cityNameRu,
          residenceCountry: activeProfile.residenceCountry,
          residenceCityName: activeProfile.residenceCityName,
          cityId: activeProfile.cityId,
          lat: typeof activeProfile.lat === 'number' && Number.isFinite(activeProfile.lat)
            ? activeProfile.lat
            : Number.NaN,
          lon: typeof activeProfile.lon === 'number' && Number.isFinite(activeProfile.lon)
            ? activeProfile.lon
            : Number.NaN,
          updated_at: activeProfile.updatedAt,
        }
      : null;
    const activeProfileFingerprint = hasFingerprintableCore(activeProfileSnapshot)
      ? personFingerprint(activeProfileSnapshot)
      : null;

    async function loadChart() {
      if (initialLoadCompleteRef.current && !skipLocalCache && !fromFile) {
        return;
      }
      let fallbackProfile: ProfileSnapshot | null = null;
      try {
        setLoading(true);
        setError(null);

        // Получаем сессию всегда (нужна для облачных запросов и профиля)
        setProgress({ percent: 5, message: "Проверяем сессию..." });
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        const activeSession = sessionData?.session;
        if (!activeSession?.user) {
          navigate("/", { replace: true });
          return;
        }
        const sessionUserId = activeSession.user.id;
        if (currentUserId !== sessionUserId) {
          setCurrentUserId(sessionUserId);
        }

        // Если forceRefresh=1, игнорировать кэш/облако загрузки расчёта и перейти к сбору профиля
  if (!skipLocalCache) {
          // Получаем профиль из localStorage
          try {
            const savedRecord = readSavedChart<Record<string, unknown>>(sessionUserId);
            const data = savedRecord?.payload;
            const recordSource: SavedChartSource = savedRecord?.meta?.source ?? (fromFile ? 'file' : 'local');
            const recordBehavesAsFile = fromFile || recordSource === 'file';
            if (data && isRecord(data)) {
              const savedProfile = mergeWithLocalSnapshot(
                  extractProfileSnapshot((data as Record<string, unknown>).profile ?? null),
                  { preferProvided: recordBehavesAsFile },
                  sessionUserId,
                );

                const savedFp = hasFingerprintableCore(savedProfile)
                  ? personFingerprint(savedProfile)
                  : null;
                const currentFp = activeProfileFingerprint;

                if (!recordBehavesAsFile && savedFp && currentFp && savedFp !== currentFp) {
                  console.warn("Cached chart is for different person, clearing...");
                  clearLocalChartCaches();
                } else {
                  const chartCandidate = (data as Record<string, unknown>).chart;
                  if (!cancelled && isCompleteChart(chartCandidate)) {
                    const chartResponse = chartCandidate as ChartResponse;
                    const metaSource = (data as Record<string, unknown>).meta;
                    const resolvedProfile = savedProfile ?? null;
                    const metaValue: BuildMeta = isBuildMeta(metaSource)
                      ? metaSource
                      : buildFallbackMeta(resolvedProfile);
                    const resolvedFingerprint = hasFingerprintableCore(resolvedProfile)
                      ? personFingerprint(resolvedProfile)
                      : null;
                    lastLoadedFingerprintRef.current = resolvedFingerprint;
                    if (resolvedProfile) {
                      setProfile(resolvedProfile);
                      persistProfileSnapshotLocal(resolvedProfile, sessionUserId);
                      if (!fallbackProfile) {
                        fallbackProfile = resolvedProfile;
                      }
                    } else {
                      setProfile(null);
                    }
                  setChart(chartResponse);
                  setMeta(metaValue);
                  if (typeof chartResponse.screenshotUrl === "string") {
                    setChartScreenshot(chartResponse.screenshotUrl);
                    setChartScreenshotHash(
                      typeof chartResponse.screenshotHash === 'string' ? chartResponse.screenshotHash : null,
                    );
                    setScreenshotStatus(null);
                  }
                  setChartSource(recordSource);
                  setProgress({ percent: 100, message: "Загружен сохранённый расчёт." });
                  const fromFileSession = Boolean(recordBehavesAsFile);
                  loadedFromFileRef.current = fromFileSession;
                  setLoadedFromFile(fromFileSession);
                  if (fromFileSession) {
                    autoSavePendingRef.current = true;
                    autoSaveFingerprintRef.current = null;
                    fileAutoSaveRef.current = true;
                    requestScreenshotRefresh();
                  } else {
                    autoSavePendingRef.current = false;
                  }
                  setLoading(false);
                  initialLoadCompleteRef.current = true;
                  if (fromFile) {
                    try {
                      const url = new URL(window.location.href);
                      url.searchParams.delete("fromFile");
                      window.history.replaceState(null, "", url.toString());
                    } catch (e) {
                      console.warn("Failed to clean fromFile param", e);
                    }
                  }
                  return;
                }
              }
            }
          } catch (e) {
            console.warn("Не удалось прочитать сохранённый расчёт из localStorage", e);
          }

          // Получаем профиль/расчёт из облака (сохранённый гороскоп)
          setProgress({ percent: 18, message: "Ищем сохранённый гороскоп..." });
            try {
              const { data: savedChartRow, error: savedChartError } = await supabase
                .from("charts")
                .select("profile, chart, meta, updated_at")
                .eq("user_id", activeSession.user.id)
                .order("updated_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (savedChartError && savedChartError.code !== "PGRST116") {
                console.warn("Ошибка загрузки сохранённого гороскопа:", savedChartError);
              }
              if (savedChartRow && !cancelled) {
                const profilePayload = savedChartRow.profile ?? null;
                let mergedProfile = profilePayload
                  ? mergeWithLocalSnapshot(
                      extractProfileSnapshot(profilePayload),
                      { preferProvided: fromFile },
                      sessionUserId,
                    )
                  : null;
                if (mergedProfile && !fromFile) {
                  const savedFp = hasFingerprintableCore(mergedProfile)
                    ? personFingerprint(mergedProfile)
                    : null;
                  if (savedFp && activeProfileFingerprint && savedFp !== activeProfileFingerprint) {
                    console.warn('Saved Supabase chart belongs to different person, skipping cached chart');
                    mergedProfile = null;
                  }
                }

                if (isCompleteChart(savedChartRow.chart) && isBuildMeta(savedChartRow.meta)) {
                  const resolvedProfile = mergedProfile ?? fallbackProfile ?? null;
                  const chartResponse = savedChartRow.chart;
                  const fingerprint = hasFingerprintableCore(resolvedProfile)
                    ? personFingerprint(resolvedProfile)
                    : null;
                  lastLoadedFingerprintRef.current = fingerprint;
                  if (resolvedProfile) {
                    setProfile(resolvedProfile);
                    persistProfileSnapshotLocal(resolvedProfile, sessionUserId);
                    if (!fallbackProfile) {
                      fallbackProfile = resolvedProfile;
                    }
                  } else {
                    setProfile(null);
                  }
                  setChart(chartResponse);
                  setMeta(savedChartRow.meta);
                  setChartSource('cloud');
                  if (typeof chartResponse.screenshotUrl === "string") {
                    setChartScreenshot(chartResponse.screenshotUrl);
                    setChartScreenshotHash(
                      typeof chartResponse.screenshotHash === 'string' ? chartResponse.screenshotHash : null,
                    );
                    setScreenshotStatus(null);
                  }
                  setProgress({ percent: 100, message: "Загружен сохранённый расчёт." });
                  loadedFromFileRef.current = false;
                  setLoadedFromFile(false);
                  autoSavePendingRef.current = false;
                  autoSaveFingerprintRef.current = computeChartFingerprint(chartResponse, savedChartRow.meta) ?? null;
                    setLoading(false);
                    initialLoadCompleteRef.current = true;
                  return;
                }
              }
            } catch (cloudErr) {
              console.warn("Не удалось получить сохранённый гороскоп из облака:", cloudErr);
            }
        }

        if (profile !== null || chart !== null || meta !== null) {
          return;
        }

        setProgress({ percent: 20, message: "Загружаем профиль пользователя..." });
        const { data: profileRow, error: profileError } = await supabase
          .from("profiles")
          .select("data")
          .eq("id", activeSession.user.id)
          .single();
        if (profileError) {
          throw profileError;
        }
        // Читаем локальный снимок (без слияния, чтобы сравнить свежесть)
        // Use only global store for local snapshot
        let localSnapshotOnly: ProfileSnapshot | null = null;
        if (useProfile.getState) {
          const profile = useProfile.getState().profile;
          localSnapshotOnly = profile
            ? {
                personName: profile.firstName,
                lastName: profile.lastName,
                birth: profile.birth,
                gender: profile.gender,
                country: profile.country,
                selectedCity: profile.cityName,
                cityNameRu: profile.cityNameRu,
                residenceCountry: profile.residenceCountry,
                residenceCityName: profile.residenceCityName,
                cityId: profile.cityId,
                lat: typeof profile.lat === 'number' ? profile.lat : 0,
                lon: typeof profile.lon === 'number' ? profile.lon : 0,
                updated_at: profile.updatedAt,
              }
            : null;
        }

        const cloudSnapshot = extractProfileSnapshot(profileRow?.data ?? null);
        const pickDirectSnapshot = (candidate: ProfileSnapshot | null | undefined) =>
          hasFingerprintableCore(candidate) ? candidate : null;
        let snapshot = skipLocalCache
          ? (pickDirectSnapshot(localSnapshotOnly)
              ?? pickDirectSnapshot(fallbackProfile)
              ?? pickDirectSnapshot(cloudSnapshot))
          : pickFreshProfile(localSnapshotOnly, fallbackProfile, cloudSnapshot);
        if (snapshot) {
          const fp = hasFingerprintableCore(snapshot) ? personFingerprint(snapshot) : null;
          if (!skipLocalCache && lastLoadedFingerprintRef.current && fp && fp !== lastLoadedFingerprintRef.current && !fromFile) {
            snapshot = fallbackProfile ?? cloudSnapshot ?? localSnapshotOnly;
          }
        }
        if (!snapshot && hasFingerprintableCore(fallbackProfile)) {
          snapshot = fallbackProfile;
        }
        if (!snapshot) {
          throw new Error("Профиль не найден. Вернитесь на страницу ввода данных.");
        }
        setProgress({ percent: 32, message: "Готовим данные для расчёта..." });
        const payloadResult = buildChartPayload(snapshot);
        if (!payloadResult.ok) {
          throw new Error(payloadResult.error);
        }
        const endpoint = `${API_BASE_URL.replace(/\/$/, "")}/api/chart`;
        setProgress({ percent: 45, message: "Отправляем запрос на сервер..." });
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadResult.request),
        });
        setProgress({ percent: 65, message: "Получаем данные с сервера..." });
        if (!response.ok) {
          const bodyText = await response.text();
          throw new Error(`Запрос к серверу расчётов не удался (${response.status}): ${bodyText}`);
        }
        setProgress({ percent: 65, message: "Получаем расчёт домов и планет..." });
        const json = (await response.json()) as ChartResponse;
        if (cancelled) return;
        setProgress({ percent: 92, message: "Обновляем интерфейс..." });

        // Extract ascSign from chart and update profile
        const ascSign = extractAscSignFromChart(json);
        const updatedSnapshot = ascSign ? { ...snapshot, ascSign } : snapshot;
        const localizedSnapshot = ensureProfileLocalization(updatedSnapshot);

        setProfile(localizedSnapshot);
        lastLoadedFingerprintRef.current = hasFingerprintableCore(localizedSnapshot)
          ? personFingerprint(localizedSnapshot)
          : null;
        persistProfileSnapshotLocal(localizedSnapshot, sessionUserId);

        // Update global profile store with ascSign
        if (ascSign) {
          setGlobalProfile({ ascSign });
        }

        // Save updated profile with ascSign to cloud
        if (ascSign) {
          try {
            const { data: sessionData } = await supabase.auth.getSession();
            const userId = sessionData?.session?.user?.id;
            if (userId) {
            await supabase.from('profiles').upsert({ id: userId, data: localizedSnapshot ?? updatedSnapshot }).select('id');
            }
          } catch (cloudErr) {
            console.warn('Failed to save ascSign to cloud profile:', cloudErr);
          }
        }

        setChart(json);
        setMeta(payloadResult.meta);
        setChartSource('local');
        loadedFromFileRef.current = false;
        setLoadedFromFile(false);
        autoSavePendingRef.current = true;
        autoSaveFingerprintRef.current = null;
        setProgress({ percent: 100, message: "Готово!" });
        setTimeout(() => {
          setLoading(false);
        }, 300);
        initialLoadCompleteRef.current = true;
        // Это расчёт с сервера по профилю, не считаем как "из файла"
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setProgress({ percent: 100, message: "Ошибка при расчёте" });
        setError(message);
        setChart(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadChart();

    return () => {
      cancelled = true;
    };
  }, [navigate, skipLocalCache, fromFile, profile, chart, meta, currentUserId, clearLocalChartCaches, storeProfile, setGlobalProfile, requestScreenshotRefresh]);

  useEffect(() => {
    if (!chart || !profile || !meta || !currentUserId) return;
    try {
      const payloadToSave = { profile: profile ?? null, chart: chart ?? null, meta: meta ?? null };
      const fingerprint = computeChartFingerprint(chart, meta);
      const sourceForSave: SavedChartSource = chartSource ?? (fromFile ? 'file' : 'local');
      writeSavedChart(payloadToSave, currentUserId, {
        meta: {
          source: sourceForSave,
          updatedAt: Date.now(),
          fingerprint: fingerprint ?? null,
        },
      });
    } catch (storageError) {
      console.warn('Failed to seed saved chart payload', storageError);
    }
  }, [chart, profile, meta, currentUserId, chartSource, fromFile]);

  // Получаем свежий профиль для расчёта — выполняется внутри loadChart()

// (effect moved below after dependent values are declared)

  // Local time formatting helper
  function formatLocalTime(birth: string | undefined) {
    if (!birth) return "—";
    const trimmed = birth.trim();
    if (!trimmed) return "—";
    if (trimmed.includes(";")) return trimmed;

    const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(.*)$/);
    if (isoMatch) {
      const [, date, time, rest = ""] = isoMatch;
      return `${date}; T${time}${rest}`;
    }
    const spaceMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(.*)$/);
    if (spaceMatch) {
      const [, date, time, rest = ""] = spaceMatch;
      return `${date}; T${time}${rest}`;
    }
    return trimmed;
  }

  // Формируем planetLabels с учётом ретроградности

  // Group planets by IAU arc code for display in the arcs table
  const planetsByArc = useMemo(() => {
    const map = new Map<string, ChartResponse['planets']>();
    if (!chart) return map;
  // initialize keys from arcs
  const arcs = Array.isArray(chart.constellation_arcs) ? chart.constellation_arcs : [];
  arcs.forEach((a) => map.set(a.iau_code, []));
    // helper to test numeric containment for safety
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
        // fallback: find arc by numeric containment
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
    // sort planets inside each arc by longitude
    for (const [k, arr] of map.entries()) {
      if (arr && arr.length) arr.sort((a, b) => (a.lon_sidereal - b.lon_sidereal));
      map.set(k, arr);
    }
    return map;
  }, [chart]);

  const personLabel = useMemo(() => {
    if (!profile) return "";
    return [profile.personName, profile.lastName].filter(Boolean).join(" ");
  }, [profile]);
  const buildProfileForCloud = useCallback((): ProfileSnapshot | null => {
    if (!profile) return null;
    const localized = ensureProfileLocalization({ ...profile });
    if (!localized) return null;

    const localizedFingerprint = personFingerprint(localized);
    let samePersonAsStore = false;
    if (storeProfile && localizedFingerprint) {
      const storeSnapshot: ProfileSnapshot = {
        personName: storeProfile.firstName,
        lastName: storeProfile.lastName,
        birth: storeProfile.birth,
        gender: storeProfile.gender,
        country: storeProfile.country,
        cityQuery: storeProfile.cityNameRu,
        selectedCity: storeProfile.cityName,
        cityId: storeProfile.cityId,
        cityNameRu: storeProfile.cityNameRu,
        lat: typeof storeProfile.lat === 'number' ? storeProfile.lat : Number.NaN,
        lon: typeof storeProfile.lon === 'number' ? storeProfile.lon : Number.NaN,
      };
      const storeFingerprint = personFingerprint(storeSnapshot);
      samePersonAsStore = Boolean(storeFingerprint && storeFingerprint === localizedFingerprint);
    }

    return {
      ...localized,
      residenceCountry: samePersonAsStore
        ? localized.residenceCountry ?? storeProfile?.residenceCountry ?? undefined
        : localized.residenceCountry ?? undefined,
      residenceCityName: samePersonAsStore
        ? localized.residenceCityName ?? storeProfile?.residenceCityName ?? undefined
        : localized.residenceCityName ?? undefined,
    };
  }, [profile, storeProfile]);
// Capture SVG of NorthIndianChart as PNG data URL and save to localStorage / cloud
  useEffect(() => {
    if (!screenshotTaskKey) return;
    const chartSnapshot = chartLatestRef.current;
    if (!chartSnapshot) return;
    const metaSource = chartSource ?? (fromFile ? 'file' : 'local');
    let unmounted = false;
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const runCapture = async () => {
      screenshotPhaseRef.current = 'capturing';
      setScreenshotStatus('Готовим скриншот...');
      const hasLocalData = typeof chartSnapshot.screenshotUrl === 'string'
        && (chartSnapshot.screenshotUrl.startsWith('data:') || chartSnapshot.screenshotUrl.startsWith('blob:'));

      const captureAttempt = async (): Promise<{ dataUrl: string; blob: Blob; hash: string | null } | null> => {
        let dataUrl = hasLocalData ? chartSnapshot.screenshotUrl! : null;
        if (!dataUrl) {
          dataUrl = await captureChartImage();
        }
        if (!dataUrl) return null;
        try {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          const hash = await computeBlobSha256(blob);
          return { dataUrl, blob, hash };
        } catch (hashErr) {
          console.warn('Не удалось подготовить blob скриншота', hashErr);
          return null;
        }
      };

      let attempt = 0;
      let capture = await captureAttempt();
      while (!unmounted && attempt < 2) {
        const tooSmall = capture?.blob ? capture.blob.size < 5000 : true;
        if (!tooSmall) break;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        capture = await captureAttempt();
        attempt += 1;
      }
      if (!capture) {
        if (!unmounted) {
          screenshotPhaseRef.current = 'idle';
          setScreenshotStatus('Не удалось снять скриншот. Попробуйте ещё раз.');
        }
        return;
      }
      const { dataUrl } = capture;
      let { blob: blobPng, hash: screenshotHash } = capture;

      if (!unmounted) {
        screenshotPhaseRef.current = 'capturing';
        setChartScreenshot(dataUrl);
        setChartScreenshotHash(screenshotHash);
        setScreenshotStatus(
          `Скриншот сохранён локально${screenshotHash ? ` (hash ${screenshotHash.slice(0, 8)})` : ''}`,
        );
        lastScreenshotUploadRef.current = { location: 'local' };
        setChart((prev) => (prev ? { ...prev, screenshotUrl: dataUrl, screenshotHash } : prev));
      }

      try {
        updateSavedChartLocalStorage(currentUserId ?? null, (payload) => {
          const existingChart = 'chart' in payload ? payload.chart : undefined;
          const chartSource = isRecord(existingChart) ? existingChart : toJsonRecord(chartSnapshot);
          return { ...payload, chart: mergeChartWithScreenshot(chartSource, dataUrl, screenshotHash) };
        }, { source: metaSource, updatedAt: Date.now() });
      } catch (storageError) {
        console.warn('Failed to write screenshot to localStorage', storageError);
      }

      try {
        if (!unmounted) {
          screenshotPhaseRef.current = 'uploading';
          setScreenshotStatus('Загружаем скриншот в облако...');
        }
        if (!blobPng) {
          const res = await fetch(dataUrl);
          blobPng = await res.blob();
          screenshotHash = await computeBlobSha256(blobPng);
        }
        const effectiveHash = screenshotHash;
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData?.session?.user?.id;
        if (!userId) return;
        const filename = `chart-${userId}-${effectiveHash ?? Date.now()}.png`;
        const preferredBuckets = ['charts-screenshots', 'charts', 'public', 'screenshots'];
        let uploadedBucket: string | null = null;
        let uploadErr: unknown = null;
        for (const bucket of preferredBuckets) {
          try {
            const { error } = await supabase.storage.from(bucket).upload(filename, blobPng, { contentType: 'image/png', upsert: true });
            if (!error) {
              uploadedBucket = bucket;
              uploadErr = null;
              break;
            }
            uploadErr = error;
            if (String(error).includes('Bucket not found')) {
              console.warn(`Bucket ${bucket} not found, trying next...`);
              continue;
            } else {
              console.warn('Supabase storage upload error:', error);
              break;
            }
          } catch (e) {
            uploadErr = e;
            console.warn('Supabase storage upload exception:', e);
          }
        }
        if (!uploadedBucket) {
          if (uploadErr) {
            console.warn('All storage upload attempts failed:', uploadErr);
          }
          if (!unmounted) {
            screenshotPhaseRef.current = 'ready';
            setScreenshotStatus('Не удалось загрузить скриншот в облако.');
          }
          return;
        }
        const storagePointer = encodeSupabasePointer({ bucket: uploadedBucket, path: filename });
        const resolvedUrl = await resolveSupabaseScreenshotUrl(storagePointer);
        const persistedUrl = resolvedUrl ?? storagePointer;
        if (!unmounted) {
          screenshotPhaseRef.current = 'ready';
          setChartScreenshot(persistedUrl);
          setChartScreenshotHash(effectiveHash ?? null);
          setScreenshotStatus(
            `Скриншот загружен в облако (${uploadedBucket})${effectiveHash ? ` (hash ${effectiveHash.slice(0, 8)})` : ''}`,
          );
          lastScreenshotUploadRef.current = { location: 'cloud', bucket: uploadedBucket };
          setChart((prev) => (prev ? { ...prev, screenshotUrl: persistedUrl, screenshotHash: effectiveHash ?? prev.screenshotHash ?? null, screenshotStoragePointer: storagePointer } : prev));
        }
        try {
          updateSavedChartLocalStorage(currentUserId ?? null, (payload) => {
            const existingChart = 'chart' in payload ? payload.chart : undefined;
            const chartSource = isRecord(existingChart) ? existingChart : toJsonRecord(chartSnapshot);
            return { ...payload, chart: mergeChartWithScreenshot(chartSource, persistedUrl, effectiveHash, storagePointer) };
          }, { source: metaSource, updatedAt: Date.now() });
        } catch (storageError) {
          console.warn('Failed to write public screenshot URL to localStorage', storageError);
        }
        try {
          const { data: chartsData, error: chartsError } = await supabase
            .from('charts')
            .select('id, chart')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);
          const buildChartPayload = (): JsonRecord | null => {
            if (!chartSnapshot) return null;
            const baseChart = toJsonRecord(chartSnapshot);
            return mergeChartWithScreenshot(baseChart, persistedUrl, effectiveHash ?? null, storagePointer);
          };
          if (!chartsError && Array.isArray(chartsData) && chartsData.length > 0) {
            const latestEntry = chartsData[0];
            const entryIdRaw = isRecord(latestEntry) ? latestEntry.id : null;
            const entryId =
              typeof entryIdRaw === 'string'
                ? entryIdRaw
                : typeof entryIdRaw === 'number'
                  ? entryIdRaw
                  : null;
            if (entryId !== null && isRecord(latestEntry)) {
              const existingChartDb = isRecord(latestEntry.chart) ? latestEntry.chart : null;
              const hasCoreData = (obj: JsonRecord | null | undefined): obj is JsonRecord => {
                if (!obj) return false;
                const hasPlanets = Array.isArray(obj.planets);
                const hasHouses = Array.isArray(obj.houses);
                return hasPlanets || hasHouses || Boolean(obj.ascendant);
              };
              const candidateChart = hasCoreData(existingChartDb)
                ? existingChartDb
                : toJsonRecord(chartSnapshot);

              if (candidateChart && persistedUrl) {
                await supabase
                  .from('charts')
                  .update({
                    chart: {
                      ...candidateChart,
                      screenshotUrl: persistedUrl,
                      screenshotHash: effectiveHash ?? null,
                      screenshotStoragePointer: storagePointer ?? candidateChart.screenshotStoragePointer ?? null,
                    },
                  })
                  .eq('id', entryId);
              } else {
                console.warn('Skip DB screenshot update: no chart data to merge, avoiding overwrite.');
              }
            }
          } else if (!chartsError) {
            const chartPayload = buildChartPayload();
            if (chartPayload) {
              try {
                const profileForCloud = buildProfileForCloud() ?? profile ?? null;
                const autoName = personLabel ? `${personLabel} (импорт)` : 'Импортированный расчёт';
                await saveChart(
                  userId,
                  autoName,
                  'private',
                  profileForCloud,
                  chartPayload,
                  meta ?? undefined,
                );
              } catch (insertErr) {
                console.warn('Failed to insert chart before screenshot update', insertErr);
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update charts row with screenshotUrl', e);
        }
      } catch (e) {
        console.warn('Failed to upload screenshot to Supabase Storage', e);
        if (!unmounted) {
          screenshotPhaseRef.current = 'ready';
          setScreenshotStatus('Ошибка при загрузке скриншота.');
        }
      }
    };

    const scheduleCapture = () => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        rafId = window.requestAnimationFrame(() => {
          void runCapture();
        });
      } else {
        timeoutId = setTimeout(() => {
          void runCapture();
        }, 0);
      }
    };

    scheduleCapture();

    return () => {
      unmounted = true;
      screenshotPhaseRef.current = 'idle';
      if (typeof window !== 'undefined') {
        if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(rafId);
        }
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    };
  }, [
    screenshotTaskKey,
    captureChartImage,
    currentUserId,
    chartSource,
    fromFile,
    buildProfileForCloud,
    profile,
    meta,
    personLabel,
  ]);
  const genderText = profile?.gender === 'male' ? 'мужской' : profile?.gender === 'female' ? 'женский' : '—';

  const planetArcStats = useMemo<PlanetArcStat[]>(() => {
    if (!chart?.planets) return [];
    const arcs = Array.isArray(chart.constellation_arcs) ? chart.constellation_arcs : [];
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
  }, [chart]);

  const sunPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Su") ?? null;
  }, [chart]);
  const moonPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Mo") ?? null;
  }, [chart]);

  const sunBaseHouse = sunPlanet?.house ?? null;
  const moonBaseHouse = moonPlanet?.house ?? null;

  const variantShift = useMemo(() => {
    if (chartVariant === "chandra" && typeof moonBaseHouse === "number") {
      return (moonBaseHouse - 1 + 12) % 12;
    }
    if (chartVariant === "surya" && typeof sunBaseHouse === "number") {
      return (sunBaseHouse - 1 + 12) % 12;
    }
    return 0;
  }, [chartVariant, moonBaseHouse, sunBaseHouse]);

  const planetMarkers = useMemo(() => {
    const markers = new Map<string, string[]>();
    if (!chart?.planets) return markers;
    // base dignity markers
    chart.planets.forEach((planet) => {
      const symbols: string[] = [];
      const sign = planet.sign;
      const rotatedHouse = rotateHouseNumber(planet.house ?? null, variantShift);
      if (sign && EXALTATION_SIGNS[planet.name]?.includes(sign)) {
        symbols.push("↑");
      }
      if (sign && DEBILITATION_SIGNS[planet.name]?.includes(sign)) {
        symbols.push("↓");
      }
      if (rotatedHouse && KARAKA_HOUSES[planet.name]?.includes(rotatedHouse)) {
        symbols.push("○");
      }
      if (rotatedHouse && DIGBALA_HOUSES[planet.name]?.includes(rotatedHouse)) {
        symbols.push("□");
      }
      if (sign && OWN_SIGN_SIGNS[planet.name]?.includes(sign)) {
        symbols.push("⌂");
      }
      if (symbols.length) {
        markers.set(planet.name, symbols);
      }
    });

    // helper to get or init markers array
    const pushMarker = (name: string, symbol: string) => {
      const arr = markers.get(name) ?? [];
      if (!arr.includes(symbol)) {
        arr.push(symbol);
        markers.set(name, arr);
      }
    };

    // combustion (●) and super-strong (☼) relative to Sun in same rotated house
    const sun = chart.planets.find((p) => p.name === "Su") || null;
    if (sun) {
      const sunRotatedHouse = rotateHouseNumber(sun.house ?? null, variantShift);
      const sunDeg = ((sun.lon_sidereal % 30) + 30) % 30;
      chart.planets.forEach((p) => {
        // Exclusions: Sun itself, Moon, Rahu, Ketu don't burn or get burned per rule
        if (p.name === "Su" || p.name === "Mo" || p.name === "Ra" || p.name === "Ke") return;
        const prh = rotateHouseNumber(p.house ?? null, variantShift);
        if (!prh || !sunRotatedHouse || prh !== sunRotatedHouse) return; // must be same house
        const pDeg = ((p.lon_sidereal % 30) + 30) % 30;
        const diff = Math.abs(pDeg - sunDeg);

        // Jupiter threshold depends on exaltation or digbala
        const isJupiterExalt = p.sign && EXALTATION_SIGNS["Ju"]?.includes(p.sign);
        const isJupiterDigbala = typeof prh === "number" && DIGBALA_HOUSES["Ju"]?.includes(prh);
        const jupThresh = (isJupiterExalt || isJupiterDigbala) ? 5 : 7;

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
            // super strong overrides visual combustion mark
            pushMarker(p.name, "☼");
          } else if (diff <= thr) {
            pushMarker(p.name, "●");
          }
        }
      });
    }

    // planetary war (Ø): exclude Su, Mo, Ra, Ke; within same rotated house and <1° difference
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
    // build components per house using <1° adjacency
    for (const arr of groupsByHouse.values()) {
      if (arr.length < 2) continue;
      // adjacency graph: edge if |deg_i - deg_j| < 1
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
        // winner is min degree; others lose
        let minIdx = idxs[0];
        for (const k of idxs) {
          if (arr[k].deg < arr[minIdx].deg) minIdx = k;
        }
        idxs.forEach((k) => {
          if (k !== minIdx) pushMarker(arr[k].name, "Ø");
        });
      };
      for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        // DFS component
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

  const baseOffsetText = meta ? formatOffset(meta.baseOffsetMinutes) : "";
  const finalOffsetText = meta ? formatOffset(meta.finalOffsetMinutes) : "";

  const houses = useMemo(() => {
    if (!chart) return [];
    const boxes = Array.isArray(chart.north_indian_layout?.boxes) ? chart.north_indian_layout.boxes : [];
    const retroMap = new Map<string, boolean>();
    if (Array.isArray(chart.planets)) {
      chart.planets.forEach((planet) => {
        retroMap.set(planet.name, !!planet.is_retrograde);
      });
    }
    const rotated = boxes.map((box) => {
      const rotatedHouse = rotateHouseNumber(box.house, variantShift) ?? box.house ?? 0;
      const signInfo = SIGN_INFO[box.sign] ?? { index: 0, ru: box.sign, en: box.sign };
      const planetLabels = Array.isArray(box.bodies)
        ? box.bodies.map((code) => (retroMap.get(code) ? `${code} R` : code))
        : [];
      const aspectLabels = Array.isArray(box.aspects)
        ? box.aspects.map((aspect) => aspect.label)
        : [];
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

  const firstHouseBox = houses.find((house) => house.houseNumber === 1);
  const ascSignCode = firstHouseBox?.sign ?? chart?.ascendant?.sign ?? "";
  const ascSignName = SIGN_INFO[ascSignCode]?.ru ?? ascSignCode;
  const ascDescription = (chartTextResources?.ascSignDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.ascSignDescriptions)[ascSignCode] ?? "";

  const ascLongitudeValue = (() => {
    if (chartVariant === "chandra") {
      return moonPlanet?.lon_sidereal ?? null;
    }
    if (chartVariant === "surya") {
      return sunPlanet?.lon_sidereal ?? null;
    }
    return chart?.ascendant?.lon_sidereal ?? null;
  })();

  const ascLongitudeText = ascLongitudeValue !== null ? formatDegrees(ascLongitudeValue) : "";
  const ascLongitudeShort = ascLongitudeValue !== null ? formatDegreesWithoutSeconds(ascLongitudeValue) : "";
  const ascSectionTitle = chartVariantConfig.ascTitle;
  const ascHeaderLabel = chartVariantConfig.headerAscLabel;
  const ascLongitudeHeaderSuffix = ascLongitudeShort
    ? chartVariantConfig.longitudeLabel
      ? ` - ${chartVariantConfig.longitudeLabel} ${ascLongitudeShort}`
      : ` - ${ascLongitudeShort}`
    : "";

  const lagneshaCode = ascSignCode ? LAGNESHA_BY_ASC_SIGN[ascSignCode] ?? "" : "";
  const lagneshaName = lagneshaCode ? PLANET_NAMES_RU[lagneshaCode] ?? lagneshaCode : "";
  const lagneshaDescription = lagneshaCode ? (chartTextResources?.lagneshaDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.lagneshaDescriptions)[lagneshaCode] ?? "" : "";
  const lagneshaDescriptionParts = useMemo(() => splitDescription(lagneshaDescription), [lagneshaDescription]);
  const lagneshaHeading = lagneshaDescriptionParts.heading || lagneshaName || lagneshaCode;
  const lagneshaBody = lagneshaDescriptionParts.body || (!lagneshaDescriptionParts.heading ? lagneshaDescription : "");
  const lagneshaPlanet = useMemo(() => {
    if (!lagneshaCode || !chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === lagneshaCode) ?? null;
  }, [chart, lagneshaCode]);
  const lagneshaHouseNumber = rotateHouseNumber(lagneshaPlanet?.house ?? null, variantShift);
  const lagneshaHouseTitle = lagneshaHouseNumber ? `������ � ${lagneshaHouseNumber}-� ����` : "";
  const lagneshaHouseDescription = lagneshaHouseNumber ? (chartTextResources?.lagneshaHouseDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.lagneshaHouseDescriptions)[String(lagneshaHouseNumber)] ?? "" : "";
  const lagneshaHouseDescriptionParts = useMemo(() => splitDescription(lagneshaHouseDescription), [lagneshaHouseDescription]);
  const lagneshaHouseHeading = lagneshaHouseDescriptionParts.heading || lagneshaHouseTitle;
  const lagneshaHouseBody = lagneshaHouseDescriptionParts.body || (!lagneshaHouseDescriptionParts.heading ? lagneshaHouseDescription : "");

  const sunHouseNumber = rotateHouseNumber(sunPlanet?.house ?? null, variantShift);
  const sunHouseLookup = sunHouseNumber ? (chartTextResources?.suryaBhavas ?? EMPTY_CHART_TEXT_RESOURCES.suryaBhavas)[String(sunHouseNumber)] : undefined;
  const sunHouseHeading = sunHouseLookup?.title || (sunHouseNumber ? `����� � ${sunHouseNumber}-� ����` : "");
  const sunHouseBody = sunHouseLookup?.body ?? "";

  const moonHouseNumber = rotateHouseNumber(moonPlanet?.house ?? null, variantShift);
  const moonHouseLookup = moonHouseNumber ? (chartTextResources?.chandraBhavas ?? EMPTY_CHART_TEXT_RESOURCES.chandraBhavas)[String(moonHouseNumber)] : undefined;
  const moonHouseHeading = moonHouseLookup?.title || (moonHouseNumber ? `�㭠 � ${moonHouseNumber}-� ����` : "");
  const moonHouseBody = moonHouseLookup?.body ?? "";
  const showSunSection = chartVariantConfig.skipPlanet !== "sun" && Boolean(sunHouseBody);
  const showMoonSection = chartVariantConfig.skipPlanet !== "moon" && Boolean(moonHouseBody);

  const jupiterPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Ju") ?? null;
  }, [chart]);
  const jupiterHouseNumber = rotateHouseNumber(jupiterPlanet?.house ?? null, variantShift);
  const jupiterHouseLookup = jupiterHouseNumber ? (chartTextResources?.guruBhavas ?? EMPTY_CHART_TEXT_RESOURCES.guruBhavas)[String(jupiterHouseNumber)] : undefined;
  const jupiterHouseHeading = jupiterHouseLookup?.title || (jupiterHouseNumber ? `����� � ${jupiterHouseNumber}-� ����` : "");
  const jupiterHouseBody = jupiterHouseLookup?.body ?? "";

  const mercuryPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Me") ?? null;
  }, [chart]);
  const mercuryHouseNumber = rotateHouseNumber(mercuryPlanet?.house ?? null, variantShift);
  const mercuryHouseLookup = mercuryHouseNumber ? (chartTextResources?.budhaBhavas ?? EMPTY_CHART_TEXT_RESOURCES.budhaBhavas)[String(mercuryHouseNumber)] : undefined;
  const mercuryHouseHeading = mercuryHouseLookup?.title || (mercuryHouseNumber ? `����਩ � ${mercuryHouseNumber}-� ����` : "");
  const mercuryHouseBody = mercuryHouseLookup?.body ?? "";

  const venusPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Ve") ?? null;
  }, [chart]);
  const venusHouseNumber = rotateHouseNumber(venusPlanet?.house ?? null, variantShift);
  const venusHouseLookup = venusHouseNumber ? (chartTextResources?.shukraBhavas ?? EMPTY_CHART_TEXT_RESOURCES.shukraBhavas)[String(venusHouseNumber)] : undefined;
  const venusHouseHeading = venusHouseLookup?.title || (venusHouseNumber ? `����� � ${venusHouseNumber}-� ����` : "");
  const venusHouseBody = venusHouseLookup?.body ?? "";

  const saturnPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Sa") ?? null;
  }, [chart]);
  const saturnHouseNumber = rotateHouseNumber(saturnPlanet?.house ?? null, variantShift);
  const saturnHouseLookup = saturnHouseNumber ? (chartTextResources?.shaniBhavas ?? EMPTY_CHART_TEXT_RESOURCES.shaniBhavas)[String(saturnHouseNumber)] : undefined;
  const saturnHouseHeading = saturnHouseLookup?.title || (saturnHouseNumber ? `����� � ${saturnHouseNumber}-� ����` : "");
  const saturnHouseBody = saturnHouseLookup?.body ?? "";

  const marsPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Ma") ?? null;
  }, [chart]);
  const marsHouseNumber = rotateHouseNumber(marsPlanet?.house ?? null, variantShift);
  const marsHouseLookup = marsHouseNumber ? (chartTextResources?.mangalaBhavas ?? EMPTY_CHART_TEXT_RESOURCES.mangalaBhavas)[String(marsHouseNumber)] : undefined;
  const marsHouseHeading = marsHouseLookup?.title || (marsHouseNumber ? `���� � ${marsHouseNumber}-� ����` : "");
  const marsHouseBody = marsHouseLookup?.body ?? "";

  const rahuPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Ra") ?? null;
  }, [chart]);
  const rahuHouseNumber = rotateHouseNumber(rahuPlanet?.house ?? null, variantShift);
  const rahuHouseLookup = rahuHouseNumber ? (chartTextResources?.rahuBhavas ?? EMPTY_CHART_TEXT_RESOURCES.rahuBhavas)[String(rahuHouseNumber)] : undefined;
  const rahuHouseHeading = rahuHouseLookup?.title || (rahuHouseNumber ? `���� � ${rahuHouseNumber}-� ����` : "");
  const rahuHouseBody = rahuHouseLookup?.body ?? "";

  const ketuPlanet = useMemo(() => {
    if (!chart?.planets) return null;
    return chart.planets.find((planet) => planet.name === "Ke") ?? null;
  }, [chart]);
  const ketuHouseNumber = rotateHouseNumber(ketuPlanet?.house ?? null, variantShift);
  const ketuHouseLookup = ketuHouseNumber ? (chartTextResources?.ketuBhavas ?? EMPTY_CHART_TEXT_RESOURCES.ketuBhavas)[String(ketuHouseNumber)] : undefined;
  const ketuHouseHeading = ketuHouseLookup?.title || (ketuHouseNumber ? `���� � ${ketuHouseNumber}-� ����` : "");
  const ketuHouseBody = ketuHouseLookup?.body ?? "";
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
const atmaKarakaDescription = atmaKarakaCode ? (chartTextResources?.atmaKarakaDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.atmaKarakaDescriptions)[atmaKarakaCode] ?? "" : "";
const atmaKarakaDescriptionParts = useMemo(() => splitDescription(atmaKarakaDescription), [atmaKarakaDescription]);
const atmaKarakaHeading = atmaKarakaDescriptionParts.heading || atmaKarakaName || atmaKarakaCode;
const atmaKarakaBody = atmaKarakaDescriptionParts.body || (!atmaKarakaDescriptionParts.heading ? atmaKarakaDescription : "");
const daraKarakaCode = daraKarakaEntry?.planet ?? "";
const daraKarakaName = daraKarakaCode ? PLANET_NAMES_RU[daraKarakaCode] ?? daraKarakaCode : "";
const daraKarakaPercent = typeof daraKarakaEntry?.percent === "number" ? daraKarakaEntry.percent : null;
const daraKarakaArcLabel = daraKarakaEntry?.arcName ?? "";
const daraKarakaDescription = daraKarakaCode ? (chartTextResources?.daraKarakaDescriptions ?? EMPTY_CHART_TEXT_RESOURCES.daraKarakaDescriptions)[daraKarakaCode] ?? "" : "";
const daraKarakaDescriptionParts = useMemo(() => splitDescription(daraKarakaDescription), [daraKarakaDescription]);
const daraKarakaHeading = daraKarakaDescriptionParts.heading || daraKarakaName || daraKarakaCode;
const daraKarakaBody = daraKarakaDescriptionParts.body || (!daraKarakaDescriptionParts.heading ? daraKarakaDescription : "");
const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudSaveMsg, setCloudSaveMsg] = useState<string | null>(null);
  const [screenshotUploading, setScreenshotUploading] = useState(false);
  const arcsForRender = Array.isArray(chart?.constellation_arcs) ? chart.constellation_arcs : [];

  const buildEnrichedChart = useCallback((): Record<string, unknown> | null => {
    if (!chart) return null;
    const enrichedChart: Record<string, unknown> = { ...chart };
    if (atmaKarakaCode || daraKarakaCode) {
      enrichedChart.karakas = {
        ...(atmaKarakaCode ? { atma: atmaKarakaCode } : {}),
        ...(daraKarakaCode ? { dara: daraKarakaCode } : {}),
      };
      enrichedChart.karaka_descriptions = {
        ...(atmaKarakaCode
          ? {
              atma: {
                heading: atmaKarakaHeading || atmaKarakaName || atmaKarakaCode,
                body: atmaKarakaBody || '',
              },
            }
          : {}),
        ...(daraKarakaCode
          ? {
              dara: {
                heading: daraKarakaHeading || daraKarakaName || daraKarakaCode,
                body: daraKarakaBody || '',
              },
            }
          : {}),
      };
      enrichedChart.karakas_meta = {
        ...(atmaKarakaCode
          ? {
              atma: {
                percent: atmaKarakaPercent ?? null,
                arcName: atmaKarakaArcLabel || '',
              },
            }
          : {}),
        ...(daraKarakaCode
          ? {
              dara: {
                percent: daraKarakaPercent ?? null,
                arcName: daraKarakaArcLabel || '',
              },
            }
          : {}),
      };
    }
    return enrichedChart;
  }, [
    chart,
    atmaKarakaCode,
    atmaKarakaHeading,
    atmaKarakaName,
    atmaKarakaBody,
    atmaKarakaPercent,
    atmaKarakaArcLabel,
    daraKarakaCode,
    daraKarakaHeading,
    daraKarakaName,
    daraKarakaBody,
    daraKarakaPercent,
    daraKarakaArcLabel,
  ]);

  const uploadChartScreenshot = useCallback(
    async ({
      userId,
      chartId,
      screenshotDataUrl,
      screenshotHash,
      enrichedChart,
    }: {
      userId: string;
      chartId: string | number;
      screenshotDataUrl: string;
      screenshotHash?: string | null;
      enrichedChart: Record<string, unknown>;
    }): Promise<boolean> => {
      if (!screenshotDataUrl) return false;
      try {
        let persistedUrl: string | null = null;
        let storagePointer: string | null = null;
        if (screenshotDataUrl.startsWith('data:')) {
          const res = await fetch(screenshotDataUrl);
          const blobPng = await res.blob();
          const filename = `chart-${userId}-${chartId || Date.now()}.png`;
          const preferredBuckets = ['charts-screenshots', 'charts', 'public', 'screenshots'];
          let uploadedBucket: string | null = null;
          for (const bucket of preferredBuckets) {
            try {
              const { error } = await supabase.storage.from(bucket).upload(filename, blobPng, {
                contentType: 'image/png',
                upsert: true,
              });
              if (!error) {
                uploadedBucket = bucket;
                break;
              }
              if (String(error).includes('Bucket not found')) {
                continue;
              }
              break;
            } catch (bucketError) {
              console.warn('Screenshot upload bucket error', bucketError);
            }
          }
          if (uploadedBucket) {
            storagePointer = encodeSupabasePointer({ bucket: uploadedBucket, path: filename });
            persistedUrl = (await resolveSupabaseScreenshotUrl(storagePointer)) ?? storagePointer;
          }
        } else if (screenshotDataUrl.startsWith('http')) {
          persistedUrl = screenshotDataUrl;
        }
        if (!persistedUrl && needsSupabaseResolution(screenshotDataUrl)) {
          const pointer = parseSupabaseStoragePointer(screenshotDataUrl);
          if (pointer) {
            storagePointer = encodeSupabasePointer(pointer);
            persistedUrl = (await resolveSupabaseScreenshotUrl(storagePointer)) ?? screenshotDataUrl;
          }
        }
        const finalScreenshotUrl = persistedUrl ?? screenshotDataUrl;
        await supabase
          .from('charts')
          .update({
            chart: {
              ...enrichedChart,
              screenshotUrl: finalScreenshotUrl,
              screenshotHash: screenshotHash ?? null,
              screenshotStoragePointer: storagePointer,
            },
          })
          .eq('id', chartId);
        return true;
      } catch (error) {
        console.warn('Failed to upload chart screenshot', error);
        try {
          await supabase
            .from('charts')
            .update({ chart: { ...enrichedChart, screenshotUrl: screenshotDataUrl, screenshotHash: screenshotHash ?? null } })
            .eq('id', chartId);
        } catch (fallbackError) {
          console.warn('Fallback screenshot persistence failed', fallbackError);
          return false;
        }
        return false;
      }
    },
    [],
  );

  const saveChartToCloud = useCallback(
    async (options: CloudSaveOptions = {}): Promise<CloudSaveResult> => {
      const {
        silent = true,
        skipIfUnchanged = true,
        updateStatus,
        notifyScreenshotUploading,
      } = options;
      if (!chart || !profile) {
        if (!silent) updateStatus?.('Нет данных для сохранения.');
        return { success: false };
      }
      const profileForCloud = buildProfileForCloud();
      if (!profileForCloud) {
        if (!silent) updateStatus?.('Не удалось подготовить профиль для сохранения.');
        return { success: false };
      }
      const enrichedChart = buildEnrichedChart();
      if (!enrichedChart) {
        if (!silent) updateStatus?.('Нет данных карты для сохранения.');
        return { success: false };
      }
      const fingerprint = computeChartFingerprint(chart, meta);
      if (skipIfUnchanged && fingerprint) {
        const lastFingerprint = readLastSavedChartFingerprint();
        if (lastFingerprint && lastFingerprint === fingerprint) {
          return { success: true, skipped: true };
        }
      }
      updateStatus?.('Проверяем сессию...');
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const userId = sessionData?.session?.user?.id;
      if (!userId) {
        if (!silent) updateStatus?.('Пользователь не авторизован.');
        return { success: false };
      }
      updateStatus?.('Обновляем профиль...');
      try {
        await supabase.from('profiles').upsert({ id: userId, data: profileForCloud }).select('id');
      } catch (profileError) {
        if (!silent) updateStatus?.('Не удалось обновить профиль в облаке.');
        throw profileError;
      }
      const name = `${personLabel || 'chart'} ${new Date().toLocaleString()}`;
      updateStatus?.('Сохраняем карту...');
      const saved = await saveChart(userId, name, 'private', profileForCloud, enrichedChart, meta ?? undefined);
      let screenshotUploaded = false;
      if (chartScreenshot) {
        notifyScreenshotUploading?.(true);
        screenshotUploaded = await uploadChartScreenshot({
          userId,
          chartId: saved.id,
          screenshotDataUrl: chartScreenshot,
          screenshotHash: chartScreenshotHash ?? undefined,
          enrichedChart,
        });
        notifyScreenshotUploading?.(false);
      }
      if (fingerprint) {
        writeLastSavedChartFingerprint(fingerprint);
      }
      return { success: true, chartId: saved.id, screenshotUploaded };
    },
    [
      chart,
      profile,
      meta,
      chartScreenshot,
      chartScreenshotHash,
      buildProfileForCloud,
      buildEnrichedChart,
      personLabel,
      uploadChartScreenshot,
    ],
  );

  const handleSaveCloud = useCallback(async (): Promise<CloudSaveResult | null> => {
    autoSavePendingRef.current = false;
    setCloudSaveMsg(null);
    setCloudSaving(true);
    saveInFlightRef.current = true;
    try {
      const result = await saveChartToCloud({
        silent: false,
        skipIfUnchanged: false,
        updateStatus: (msg) => setCloudSaveMsg(msg),
        notifyScreenshotUploading: (uploading) => setScreenshotUploading(uploading),
      });
      if (!result.success) {
        if (!cloudSaveMsg) {
          setCloudSaveMsg('Не удалось сохранить карту.');
        }
        return result;
      }
      if (result.skipped) {
        setCloudSaveMsg('Изменений не обнаружено — облако уже актуально.');
      } else {
        let screenshotSuffix = '';
        if (result.screenshotUploaded) {
          const lastUpload = lastScreenshotUploadRef.current;
          if (lastUpload?.location === 'cloud' && lastUpload.bucket) {
            screenshotSuffix = ` • Скриншот загружен в облако (${lastUpload.bucket}).`;
          } else if (lastUpload?.location === 'local') {
            screenshotSuffix = ' • Скриншот сохранён только локально.';
          } else {
            screenshotSuffix = ' • Скриншот обновлён.';
          }
        }
        setCloudSaveMsg(`Карта сохранена (id: ${result.chartId})${screenshotSuffix}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudSaveMsg(`Ошибка сохранения: ${message}`);
      return null;
    } finally {
      saveInFlightRef.current = false;
      setCloudSaving(false);
      setScreenshotUploading(false);
    }
  }, [cloudSaveMsg, saveChartToCloud]);

  useEffect(() => {
    if (!autoSavePendingRef.current) return;
    if (loading) return;
    if (!chart || !profile || !meta) return;
    if (saveInFlightRef.current) return;
    if (screenshotTaskKey && screenshotPhaseRef.current !== 'ready') {
      return; // ждём завершения захвата/загрузки скриншота
    }
    const fingerprint = computeChartFingerprint(chart, meta);
    if (fingerprint && autoSaveFingerprintRef.current === fingerprint) {
      autoSavePendingRef.current = false;
      return;
    }
    autoSavePendingRef.current = false;
    void (async () => {
      const result = await handleSaveCloud();
      if (result?.success && fingerprint) {
        autoSaveFingerprintRef.current = fingerprint;
      }
    })();
  }, [
    chart,
    profile,
    meta,
    loading,
    handleSaveCloud,
    chartScreenshot,
    screenshotTaskKey,
  ]);

  useEffect(() => {
    if (!fileAutoSaveRef.current) return;
    if (loading) return;
    if (!chart || !profile || !meta) return;
    if (saveInFlightRef.current) return;
    if (screenshotTaskKey && screenshotPhaseRef.current !== 'ready') return;

    fileAutoSaveRef.current = false;
    autoSavePendingRef.current = false;
    void (async () => {
      const result = await handleSaveCloud();
      if (!result?.success) {
        fileAutoSaveRef.current = true;
      }
    })();
  }, [
    chart,
    profile,
    meta,
    loading,
    chartScreenshot,
    screenshotTaskKey,
    handleSaveCloud,
  ]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <div>
              <div className="text-lg font-semibold">Выполняем расчёт...</div>
              <div className="mt-2 text-sm text-white/60">Это может занять несколько секунд.</div>
          </div>
          <div>
            <div className="h-2 w-full rounded-full bg-white/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-white transition-all duration-500 ease-out"
                style={{ width: `${Math.min(100, Math.max(8, progress.percent))}%` }}
              />
            </div>
            <div className="mt-2 text-xs uppercase tracking-wide text-white/70">
              {progress.message}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-4">
        <div className="max-w-lg text-center space-y-4">
            <div className="text-xl font-semibold">Не удалось построить гороскоп</div>
            <div className="text-sm text-white/70 whitespace-pre-wrap">{error}</div>
            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                className={`${BUTTON_SECONDARY} px-4 py-2`}
                onClick={() => navigate("/app")}
              >
                Назад к вводу данных
              </button>
              <button
                type="button"
                className={`${BUTTON_SECONDARY} px-4 py-2`}
                onClick={() => window.location.reload()}
              >
                Повторить попытку
              </button>
          </div>
        </div>
      </div>
    );
  }

  if (!chart || !meta) {
    return null;
  }

  return (
    <>
      <div className="min-h-screen bg-slate-950 text-white">
      {licenseGate}
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-[1450px] mx-auto w-full">
          <header className="mb-6">
            <div className="flex justify-between items-center mb-4">
              <h1 className="text-3xl font-bold text-white">Натальная карта</h1>
              <div className="flex flex-wrap gap-2 items-start">
                <button
                  ref={newChartButtonRef}
                  type="button"
                  onClick={() => {
                    requestNewChartReset("chart");
                    newChartButtonRef.current?.blur();
                  }}
                  className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
                >
                  Новая карта
                </button>
                <button
                  type="button"
                  className={`${BUTTON_PRIMARY} px-3 py-1.5 text-sm cursor-default`}
                  disabled
                >
                  Натальная карта
                </button>
                <QuestionnaireButton
                  profile={profile}
                  chart={chart}
                  meta={meta}
                  navigate={navigate}
                  fromFile={loadedFromFile}
                  ownerId={currentUserId ?? null}
                />
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
                  onClick={async () => {
                    const { data: sessionData } = await supabase.auth.getSession();
                    const userId = sessionData?.session?.user?.id;
                    if (userId) navigate(`/user/${userId}`);
                  }}
                >
                  Профиль
                </button>
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
                  onClick={async () => {
                    let screenshotToUse = chartScreenshot;
                    let screenshotHashToUse = chartScreenshotHash;
                    if (!screenshotToUse) {
                      try {
                        screenshotToUse = await captureChartImage();
                        if (screenshotToUse) {
                          let computedHash: string | null = null;
                          try {
                            const res = await fetch(screenshotToUse);
                            const blob = await res.blob();
                            computedHash = await computeBlobSha256(blob);
                          } catch (hashErr) {
                            console.warn('Не удалось вычислить хеш перед переходом в синастрию', hashErr);
                          }
                          setChartScreenshot(screenshotToUse);
                          setChartScreenshotHash(computedHash);
                          screenshotHashToUse = computedHash;
                          setChart((prev) => (prev ? { ...prev, screenshotUrl: screenshotToUse, screenshotHash: computedHash ?? prev.screenshotHash ?? null } : prev));
                        }
                      } catch (captureError) {
                        console.warn('Failed to capture chart screenshot before synastry navigation', captureError);
                      }
                    }
                    try {
                      const enrichedChart = screenshotToUse && chart
                        ? mergeChartWithScreenshot(chart, screenshotToUse, screenshotHashToUse, chart.screenshotStoragePointer ?? null)
                        : (chart ?? null);
                      const payloadToSave = {
                        profile: profile ?? null,
                        chart: enrichedChart,
                        meta: meta ?? null,
                      };
                      const sourceForSynastry: SavedChartSource = loadedFromFile ? 'file' : 'local';
                      writeSavedChart(payloadToSave, currentUserId ?? null, {
                        meta: {
                          source: sourceForSynastry,
                          updatedAt: Date.now(),
                          fingerprint: null,
                        },
                      });
                    } catch (e) {
                      console.warn('Failed to persist chart/profile before navigating to sinastry:', e);
                    }
                    navigate(loadedFromFile ? '/sinastry?fromFile=1' : '/sinastry');
                  }}
                >
                  Синастрия
                </button>
              </div>
            </div>
            <div className="text-sm text-white/70">
              {personLabel && <div className="text-4xl font-bold text-white mb-3">{personLabel}</div>}
              <div className="text-sm text-white/80">Пол: {genderText}</div>
              {Boolean(profile?.cityNameRu || profile?.selectedCity) && (
                <div className="text-xs text-white/70 mt-1">
                  Город: {profile?.cityNameRu || profile?.selectedCity}
                  {Number.isFinite(profile?.lat) && Number.isFinite(profile?.lon) ? (
                    <span className="text-white/50"> · {Number(profile?.lat ?? 0).toFixed(4)}, {Number(profile?.lon ?? 0).toFixed(4)}</span>
                  ) : null}
                </div>
              )}
              <div className="text-xs text-white/50 mt-1">
                Локальное время: {formatLocalTime(profile?.birth)} ({meta?.ianaTz ?? '—'}, базовый оффсет {baseOffsetText}, итоговый {finalOffsetText})
              </div>
              {ascSignName ? (
                <div className="mt-2">
                  {ascHeaderLabel}: {ascSignName}
                  {ascLongitudeHeaderSuffix}
                </div>
              ) : null}
              {chart.mc ? (
                <div>MC: {formatDegrees(chart.mc.lon_sidereal)}</div>
              ) : null}
            </div>
          </header>
          <div className="w-full mb-4">
            <div className="text-sm text-white/70 mb-2">Тип карты</div>
            <div className="flex flex-wrap gap-2">
              {CHART_VARIANT_OPTIONS.map((option) => {
                const isActive = option.value === chartVariant;
                const isLockedVariant = !isLicensed && option.value !== "rashi";
                const baseClasses =
                  "px-3 py-2 text-left min-w-[160px] leading-tight border border-[#7a643a] bg-[#f7e4c1] text-black transition-colors";
                const stateClasses = isLockedVariant
                  ? "bg-[#e6dcc5] text-[#b5a888] border-[#b5a888] cursor-not-allowed"
                  : isActive
                  ? "bg-[#e8d7b0] text-[#9a8046] cursor-not-allowed"
                  : "hover:bg-[#edd7aa]";
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      if (isLockedVariant) {
                          try { window.electronAPI?.license?.requestPrompt?.(); } catch (promptError) {
                            console.warn('Failed to request license prompt from chart variant switch', promptError);
                          }
                        return;
                      }
                      setChartVariant(option.value);
                      setFullDetailsUnlocked(isLicensed);
                    }}
                    className={`${baseClasses} ${stateClasses}`}
                    aria-pressed={isActive}
                  >
                    <div className="text-sm font-semibold">{option.title}</div>
                    <div className="text-xs text-white/70">{option.subtitle}</div>
                  </button>
                );
              })}
              <button
                type="button"
                className={`${BUTTON_SECONDARY} px-4 py-2 text-sm self-start`}
                onClick={() => {
                  // Save chart/profile as JSON file
                  const chartForExport = chartScreenshot
                    ? mergeChartWithScreenshot(chart, chartScreenshot, chartScreenshotHash, chart.screenshotStoragePointer ?? null)
                    : chart;
                  const payload: Record<string, unknown> = {
                    chart: chartForExport,
                    profile,
                    meta,
                  };
                  if (chartScreenshot) {
                    payload.screenshot = chartScreenshot;
                    if (chartScreenshotHash) {
                      payload.screenshotHash = chartScreenshotHash;
                    }
                  }
                  const data = JSON.stringify(payload, null, 2);
                  const blob = new Blob([data], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "synastry_chart.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Сохранить в файл
              </button>
              <button
                type="button"
                className={`${BUTTON_SECONDARY} px-4 py-2 text-sm self-start`}
                onClick={() => void handleSaveCloud()}
                disabled={cloudSaving || screenshotUploading}
              >
                <span className="relative block">
                  <span className={cloudSaving || screenshotUploading ? "opacity-0" : ""}>
                    Сохранить в облако
                  </span>
                  {(cloudSaving || screenshotUploading) && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    </span>
                  )}
                </span>
              </button>
              {cloudSaveMsg && (
                <div className={`text-xs mt-2 ${cloudSaveMsg.includes('успешно') || cloudSaveMsg.includes('Карта сохранена') ? 'text-green-400' : 'text-white/70'}`}>
                  {cloudSaveMsg}
                </div>
              )}
              {screenshotStatus && (
                <div className="text-xs mt-2 text-white/70">
                  {screenshotStatus}
                </div>
              )}
            </div>
            <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/70">
              {chartVariantConfig.description}
            </div>
          </div>
          <div className="flex flex-col gap-10 min-[1200px]:flex-row min-[1200px]:items-start min-[1200px]:gap-16">
            <div ref={chartContainerRef} className="w-full max-w-[600px] min-[1200px]:flex-none min-[1200px]:basis-[600px] min-[1200px]:max-w-[600px]">
              <NorthIndianChart
                title={chartVariantConfig.chartTitle}
                houses={houses}
                centered={false}
                className="w-full"
              />
              {/* preview intentionally removed — screenshot is captured and stored but not shown here */}
            </div>
            <div className="w-full max-w-[700px] min-[1200px]:flex-none min-[1200px]:basis-[700px] min-[1200px]:max-w-[700px] mx-auto">
              <div className="text-base font-black uppercase tracking-wide text-white mb-2">
                СОЗВЕЗДИЯ И ПЛАНЕТЫ (
                <span className="normal-case font-semibold">↑-уча, ↓-нича, ○-карака, □-дигбала, ⌂-свой знак, ●-сожжёная, Ø-проигравшая, ☼-супер сильная</span>
                )
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 min-[1200px]:p-6">
                <div className="overflow-x-auto text-sm text-white/80">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead className="text-white/70 text-left">
                      <tr>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Созвездие (код)</th>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Lon start</th>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Lon end</th>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Планета</th>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Истин. созв.</th>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Долгота</th>
                        <th className="py-0.5 pr-4 whitespace-nowrap">Рет.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {arcsForRender.map((arc) => {
                        const planets = planetsByArc.get(arc.iau_code) ?? [];
                        // helper map for iau name lookup by code
                        const iauNameByCode = new Map<string, string>();
                        arcsForRender.forEach((a) => iauNameByCode.set(a.iau_code, a.iau_name_ru));
                        if (planets.length === 0) {
                          return (
                            <tr key={arc.iau_code} className="border-b border-white/10">
                              <td className="py-0.5 pr-4 align-top">{arc.iau_name_ru} ({arc.iau_code})</td>
                              <td className="py-0.5 pr-4 align-top">{formatArcDegree(arc.lon_start_deg)}</td>
                              <td className="py-0.5 pr-4 align-top">{formatArcDegree(arc.lon_end_deg)}</td>
                              <td className="py-0.5 pr-4 align-top text-white/50">-</td>
                              <td className="py-0.5 pr-4 align-top">-</td>
                              <td className="py-0.5 pr-4 align-top">-</td>
                              <td className="py-0.5 pr-4 align-top"> </td>
                            </tr>
                          );
                        }
                        // if there are planets, render one <tr> per planet and span arc columns
                        return planets.map((p, idx) => {
                          const iauCode = p.iau_constellation || arc.iau_code || '';
                          const iauNameRu = iauNameByCode.get(iauCode) || '';
                          const markersForPlanet = planetMarkers.get(p.name) ?? [];
                          return (
                            <tr key={`${arc.iau_code}-${p.name}-${idx}`} className={idx === 0 ? 'border-b border-white/10' : ''}>
                              {idx === 0 ? (
                                <>
                                  <td rowSpan={planets.length} className="py-0.5 pr-4 align-top">{arc.iau_name_ru} ({arc.iau_code})</td>
                                  <td rowSpan={planets.length} className="py-0.5 pr-4 align-top">{formatArcDegree(arc.lon_start_deg)}</td>
                                  <td rowSpan={planets.length} className="py-0.5 pr-4 align-top">{formatArcDegree(arc.lon_end_deg)}</td>
                                </>
                              ) : null}
                              <td className="py-0.5 pr-4 align-top">
                                <span className="flex items-center gap-2">
                                  <span
                                    title={`Сила: ${Math.round((p.house_strength ?? 0) * 100)}%`}
                                    style={{
                                      display: 'inline-block',
                                      width: '48px',
                                      height: '12px',
                                      borderRadius: '6px',
                                      background: '#444',
                                      position: 'relative',
                                      overflow: 'hidden',
                                      verticalAlign: 'middle',
                                    }}
                                  >
                                    <span
                                      style={{
                                        position: 'absolute',
                                        left: 0,
                                        top: 0,
                                        height: '100%',
                                        width: `${Math.round((p.house_strength ?? 0) * 100)}%`,
                                        background: (() => {
                                          const percent = p.house_strength ?? 0;
                                          if (percent <= 0.1) {
                                            // Очень малый процент — красный
                                            return '#e53935';
                                          } else if (percent < 0.5) {
                                            // Градиент от красного к жёлтому
                                            // Вычисляем цвет вручную
                                            const ratio = (percent - 0.1) / 0.4;
                                            // Красный: #e53935 (229,57,53), Жёлтый: #fbc02d (251,192,45)
                                            const r = Math.round(229 + (251 - 229) * ratio);
                                            const g = Math.round(57 + (192 - 57) * ratio);
                                            const b = Math.round(53 + (45 - 53) * ratio);
                                            return `rgb(${r},${g},${b})`;
                                          } else if (percent < 0.99) {
                                            // От жёлтого к зелёному
                                            const ratio = (percent - 0.5) / 0.49;
                                            // Жёлтый: #fbc02d (251,192,45), Зелёный: #43a047 (67,160,71)
                                            const r = Math.round(251 + (67 - 251) * ratio);
                                            const g = Math.round(192 + (160 - 192) * ratio);
                                            const b = Math.round(45 + (71 - 45) * ratio);
                                            return `rgb(${r},${g},${b})`;
                                          } else {
                                            // 100% — зелёный
                                          return '#43a047';
                                        }
                                      })(),
                                      borderRadius: '6px',
                                      transition: 'width 0.3s, background 0.3s',
                                    }}
                                  />
                                </span>
                                  {markersForPlanet.length ? (
                                    <span className="flex items-center gap-1 text-base leading-none text-white">
                                      {markersForPlanet.map((symbol, symbolIdx) => (
                                        <span key={`${p.name}-${symbol}-${symbolIdx}`}>{symbol}</span>
                                      ))}
                                    </span>
                                  ) : null}
                                  <span>{PLANET_NAMES_RU[p.name] ?? p.name}</span>
                                </span>
                              </td>
                              <td className="py-0.5 pr-4 align-top">{iauNameRu ? `${iauNameRu} (${iauCode})` : (p.iau_constellation || '')}</td>
                              <td className="py-0.5 pr-4 align-top">{formatDegreesWithoutSeconds(p.lon_sidereal)}</td>
                              <td className="py-0.5 pr-4 align-top">{p.is_retrograde ? 'R' : ''}</td>
                            </tr>
                          );
                        });
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
          {/* Description boxes below chart/table */}
          <div className="mt-6 space-y-4" style={{ marginTop: "20px", marginBottom: "30px", paddingBottom: "30px" }}>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4" style={{ marginBottom: "20px" }}>
              <div className="text-sm font-semibold mb-2"><strong>{ascSectionTitle}</strong></div>
              <div className="text-sm text-white/70 mb-2">
                {ascSignName}
                {ascLongitudeText
                  ? chartVariantConfig.longitudeLabel
                    ? ` - ${chartVariantConfig.longitudeLabel} ${ascLongitudeText}`
                    : ` - ${ascLongitudeText}`
                  : ""}
              </div>
              {ascDescription ? <div className="text-sm whitespace-pre-line">{ascDescription}</div> : null}
            </div>
            {!allowFull ? (
              <div className="flex justify-center px-2 mt-5 mb-12" style={{ marginBottom: "60px" }}>
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} rounded-xl px-4 py-3 font-bold`}
                  style={{ fontSize: "1.5rem", width: "500px", maxWidth: "100%", marginBottom: "20px" }}
                  onClick={() => {
                    if (isLicensed) {
                      setFullDetailsUnlocked(true);
                    } else {
                      try { window.electronAPI?.license?.requestPrompt?.(); } catch (promptError) {
                        console.warn('Failed to request license prompt from full description CTA', promptError);
                      }
                    }
                  }}
                >
                  {'\u041F\u041E\u041B\u041D\u041E\u0415 \u041E\u041F\u0418\u0421\u0410\u041D\u0418\u0415 \u041A\u0410\u0420\u0422\u042B'}
                </button>
              </div>
            ) : null}
            
            
            {allowFull && lagneshaDescription ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Лагнеша</strong></div>
                {lagneshaHeading ? <div className="text-sm text-white/70 mb-2">{lagneshaHeading}</div> : null}
                {lagneshaBody ? <div className="text-sm whitespace-pre-line">{lagneshaBody}</div> : null}
              </div>
            ) : null}
            {allowFull && lagneshaHouseDescription ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Лагнеша в доме</strong></div>
                {lagneshaHouseHeading ? <div className="text-sm text-white/70 mb-2">{lagneshaHouseHeading}</div> : null}
                {lagneshaHouseBody ? <div className="text-sm whitespace-pre-line">{lagneshaHouseBody}</div> : null}
              </div>
            ) : null}
            {allowFull && atmaKarakaDescription ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Атма-карака</strong></div>
                <div className="text-sm text-white/70 mb-2">{atmaKarakaHeading}{atmaKarakaPercent !== null ? ` — ${atmaKarakaPercent.toFixed(2)}%` : ''}{atmaKarakaArcLabel ? ` (${atmaKarakaArcLabel})` : ''}</div>
                {atmaKarakaBody ? <div className="text-sm whitespace-pre-line">{atmaKarakaBody}</div> : null}
              </div>
            ) : null}
            {allowFull && daraKarakaDescription ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Дара-карака</strong></div>
                <div className="text-sm text-white/70 mb-2">{daraKarakaHeading}{daraKarakaPercent !== null ? ` — ${daraKarakaPercent.toFixed(2)}%` : ''}{daraKarakaArcLabel ? ` (${daraKarakaArcLabel})` : ''}</div>
                {daraKarakaBody ? <div className="text-sm whitespace-pre-line">{daraKarakaBody}</div> : null}
              </div>
            ) : null}
            {allowFull && showSunSection ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Солнце</strong></div>
                {sunHouseHeading ? <div className="text-sm text-white/70 mb-2">{sunHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{sunHouseBody}</div>
              </div>
            ) : null}
            {allowFull && showMoonSection ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Луна</strong></div>
                {moonHouseHeading ? <div className="text-sm text-white/70 mb-2">{moonHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{moonHouseBody}</div>
              </div>
            ) : null}
            {allowFull && jupiterHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Юпитер</strong></div>
                {jupiterHouseHeading ? <div className="text-sm text-white/70 mb-2">{jupiterHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{jupiterHouseBody}</div>
              </div>
            ) : null}
            {allowFull && mercuryHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Меркурий</strong></div>
                {mercuryHouseHeading ? <div className="text-sm text-white/70 mb-2">{mercuryHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{mercuryHouseBody}</div>
              </div>
            ) : null}
            {allowFull && venusHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Венера</strong></div>
                {venusHouseHeading ? <div className="text-sm text-white/70 mb-2">{venusHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{venusHouseBody}</div>
              </div>
            ) : null}
            {allowFull && saturnHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Сатурн</strong></div>
                {saturnHouseHeading ? <div className="text-sm text-white/70 mb-2">{saturnHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{saturnHouseBody}</div>
              </div>
            ) : null}
            {allowFull && marsHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Марс</strong></div>
                {marsHouseHeading ? <div className="text-sm text-white/70 mb-2">{marsHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{marsHouseBody}</div>
              </div>
            ) : null}
            {allowFull && rahuHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Раху</strong></div>
                {rahuHouseHeading ? <div className="text-sm text-white/70 mb-2">{rahuHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{rahuHouseBody}</div>
              </div>
            ) : null}
            {allowFull && ketuHouseBody ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-sm font-semibold mb-2"><strong>Кету</strong></div>
                {ketuHouseHeading ? <div className="text-sm text-white/70 mb-2">{ketuHouseHeading}</div> : null}
                <div className="text-sm whitespace-pre-line">{ketuHouseBody}</div>
              </div>
            ) : null}

          </div>
        </div>
      </div>
    </div>
    </>
  );
};

export default ChartPage;












