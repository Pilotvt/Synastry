import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { type ChartPayload } from '../synastry/scoring';
import { analyzeKujaDosha } from '../synastry/kuja';
import { computeDirectionalSynastry } from '../synastry/directionalSummary';
import { useNetStatus } from '../context/useNetStatus';
import './UserProfilePage.css';
import { latinToRuName } from '../utils/transliterate';
import { readSavedChart, writeSavedChart, type SavedChartRecord, type SavedChartSource } from '../utils/savedChartStorage';
import { readProfileFromStorage, isOwnerMatch } from '../utils/profileStorage';
import { stripResidenceFields } from '../utils/stripResidenceFields';
import { isChartSessionFromFile } from '../utils/fromFileSession';
import { useChartCache } from '../store/chartCache';
import { encodeSupabasePointer, needsSupabaseResolution, resolveSupabaseScreenshotUrl } from '../utils/screenshotUrl';
import { useBlocklistStore } from '../store/blocklist';
import { PROFILE_SNAPSHOT_STORAGE_KEY as STORAGE_KEY } from '../constants/storageKeys';
import { requestNewChartReset } from '../utils/newChartRequest';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../constants/buttonPalette';
import AutoAspectImage from '../components/AutoAspectImage';
const CHAT_TABLE = 'user_messages';
type UserProfile = {
  personName: string;
  lastName: string;
  birth: string;
  selectedCity: string;
  cityNameRu?: string;
  residenceCountry?: string;
  residenceCityName?: string;
  mainPhoto: string | null;
  smallPhotos: (string | null)[];
  gender?: "male" | "female";
  typeazh: string;
  familyStatus: string;
  about: string;
  interests: string;
  religion: string;
  career: string;
  children: string;
  profession: string;
  ascSign?: string | null;
};
// Минимальный тип статуса лицензии (для email и доступа к анкетам)
type ElectronLicenseStatus = {
  allowed?: boolean;
  licensed?: boolean;
  identityEmail?: string | null;
  trial?: {
    daysLeft?: number | null;
  } | null;
};
type ChartRow = {
  chart?: Record<string, unknown> | null;
  [key: string]: unknown;
};
type OtherProfilePreview = {
  id: string;
  personName: string;
  lastName: string;
  selectedCity: string;
  cityNameRu?: string | null;
  residenceCountry?: string | null;
  residenceCityName?: string | null;
  mainPhoto: string | null;
  smallPhotos: (string | null)[];
  birth: string | null;
  ascSign: string | null;
  chartScreenshot: string | null;
  gender: "male" | "female" | null;
  typeazh: string;
  familyStatus: string;
  about: string;
  interests: string;
  religion: string;
  career: string;
  profession: string;
  children: string;
  chart: ChartPayload;
  chartSignature: string | null;
  lastSeenAt: string | null;
};
type CompatibilityPreview = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  percent: number | null;
  basePercent: number | null;
  kujaPenalty: number | null;
  sunMoonBonus?: number;
  hasCurrentKuja: boolean;
  hasOtherKuja: boolean;
  error?: string;
  chartSignature: string | null;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readStringProp = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

const readSavedChartSource = (ownerId?: string | null): Record<string, unknown> | null => {
  try {
    const record = readSavedChart<Record<string, unknown>>(ownerId);
    if (!record) return null;
    if (record.payload && isRecord(record.payload)) return record.payload;
    if (record.raw && isRecord(record.raw)) return record.raw as Record<string, unknown>;
    return null;
  } catch (error) {
    console.warn('Failed to read saved chart source', error);
    return null;
  }
};
function normalizeGender(value: unknown): "male" | "female" | null {
  if (value === 'male' || value === 'female') return value;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (s === 'male' || s === 'm' || s === 'м' || s === 'муж' || s === 'мужской') return 'male';
  if (s === 'female' || s === 'f' || s === 'ж' || s === 'жен' || s === 'женский') return 'female';
  return null;
}
const toChartRow = (value: unknown): ChartRow => (isRecord(value) ? { ...value } : { chart: null });
const extractChartScreenshot = (row: ChartRow | null): string | null => {
  if (!row) return null;
  const chartValue = row.chart;
  if (isRecord(chartValue)) {
    const url = typeof chartValue.screenshotUrl === 'string' ? chartValue.screenshotUrl.trim() : '';
    const pointer = typeof chartValue.screenshotStoragePointer === 'string' ? chartValue.screenshotStoragePointer : null;
    if (url && (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http'))) {
      return url;
    }
    if (pointer && pointer.trim()) {
      return pointer;
    }
    if (url) return url;
  }
  return null;
};
const applyScreenshotToChart = (row: ChartRow, screenshotUrl: string): ChartRow => {
  const chartValue = isRecord(row.chart) ? row.chart : {};
  return { ...row, chart: { ...chartValue, screenshotUrl } };
};
const resolveScreenshotFromAny = (value: unknown): string | null => {
  const pickString = (candidate: unknown): string | null =>
    typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
  if (!value) return null;
  const direct = pickString(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  const directKeys: Array<'screenshotUrl' | 'screenshot' | 'chartScreenshot'> = ['screenshotUrl', 'screenshot', 'chartScreenshot'];
  for (const key of directKeys) {
    const shot = pickString(value[key]);
    if (shot) return shot;
  }
  if ('chart' in value) {
    const nested = resolveScreenshotFromAny((value as Record<string, unknown>).chart);
    if (nested) return nested;
  }
  if ('meta' in value) {
    const nested = resolveScreenshotFromAny((value as Record<string, unknown>).meta);
    if (nested) return nested;
  }
  return null;
};
const extractChartPayload = (row: ChartRow | null): ChartPayload => {
  if (!row) return null;
  return isRecord(row.chart) ? (row.chart as Record<string, unknown>) : null;
};
const SIGN_NAMES_RU: Record<string, string> = {
  Ar: 'Овен',
  Ta: 'Телец',
  Ge: 'Близнецы',
  Cn: 'Рак',
  Le: 'Лев',
  Vi: 'Дева',
  Li: 'Весы',
  Sc: 'Скорпион',
  Sg: 'Стрелец',
  Cp: 'Козерог',
  Aq: 'Водолей',
  Pi: 'Рыбы',
};

type DisplayNamesCtor = new (locales?: string | string[], options?: { type?: 'region' }) => {
  of(code: string): string | undefined;
};

const intlWithDisplayNames = Intl as typeof Intl & { DisplayNames?: DisplayNamesCtor };
const regionNames =
  typeof Intl !== 'undefined' && typeof intlWithDisplayNames.DisplayNames === 'function'
    ? new intlWithDisplayNames.DisplayNames(['ru'], { type: 'region' })
    : null;

function countryNameRU(code?: string | null): string {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!normalized) return '';
  if (!/^[A-Z]{2,3}$/.test(normalized)) return normalized;
  try {
    return regionNames?.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

function formatResidenceLabel(city?: string | null, country?: string | null): string {
  const cityPart = typeof city === 'string' ? city.trim() : '';
  const countryCode = typeof country === 'string' ? country.trim().toUpperCase() : '';
  const countryLabel = countryCode ? countryNameRU(countryCode) : '';
  if (cityPart && countryLabel) return `${cityPart}, ${countryLabel}`;
  return cityPart || countryLabel || '';
}

const extractAscSignFromChart = (row: ChartRow | null): string | null => {
  if (!row) return null;
  const chartValue = row.chart;
  if (!isRecord(chartValue)) return null;
  const ascCandidate = chartValue.ascendant;
  if (isRecord(ascCandidate) && typeof ascCandidate.sign === 'string') {
    return SIGN_NAMES_RU[ascCandidate.sign] ?? ascCandidate.sign;
  }
  const houses = chartValue.houses;
  if (Array.isArray(houses)) {
    for (const house of houses) {
      if (!isRecord(house)) continue;
      const houseNumber = typeof house.house === 'number' ? house.house : Number(house.house);
      const signCode = typeof house.sign === 'string' ? house.sign : '';
      if (houseNumber === 1 && signCode) {
        return SIGN_NAMES_RU[signCode] ?? signCode;
      }
    }
  }
  const layout = chartValue.north_indian_layout;
  if (isRecord(layout) && Array.isArray(layout.boxes)) {
    for (const box of layout.boxes) {
      if (!isRecord(box)) continue;
      const houseNumber = typeof box.house === 'number' ? box.house : Number(box.house);
      const signCode = typeof box.sign === 'string' ? box.sign : '';
      if (houseNumber === 1 && signCode) {
        return SIGN_NAMES_RU[signCode] ?? signCode;
      }
    }
  }
  return null;
};
const parseTimestamp = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
};
const CLEARED_UNREAD_STORAGE_PREFIX = 'synastry_cleared_unread_v1';

const readClearedUnreadFromStorage = (userId: string | null): Record<string, number> => {
  if (typeof window === 'undefined' || !userId) return {};
  try {
    const raw = window.localStorage.getItem(`${CLEARED_UNREAD_STORAGE_PREFIX}:${userId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (Number.isFinite(numeric)) {
        result[key] = numeric;
      }
    }
    return result;
  } catch (error) {
    console.warn('Не удалось прочитать локальный кеш непрочитанных сообщений', error);
    return {};
  }
};

const writeClearedUnreadToStorage = (userId: string | null, map: Record<string, number>) => {
  if (typeof window === 'undefined' || !userId) return;
  try {
    window.localStorage.setItem(`${CLEARED_UNREAD_STORAGE_PREFIX}:${userId}`, JSON.stringify(map));
  } catch (error) {
    console.warn('Не удалось сохранить локальный кеш непрочитанных сообщений', error);
  }
};
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const ONLINE_THRESHOLD_MS = 2 * MINUTE_MS;

type OnlineStatusDescriptor = {
  label: string;
  badgeClass: string;
  title: string;
  isOnline: boolean;
  style: React.CSSProperties;
};

const formatAgoLabel = (diffMs: number): string => {
  if (diffMs < HOUR_MS) {
    const minutes = Math.max(1, Math.round(diffMs / MINUTE_MS));
    return `${minutes} мин`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.max(1, Math.round(diffMs / HOUR_MS));
    return `${hours} ч`;
  }
  if (diffMs < WEEK_MS) {
    const days = Math.max(1, Math.round(diffMs / DAY_MS));
    return `${days} д`;
  }
  return 'давно';
};

const describeOnlineStatus = (
  lastSeenAt: string | null,
  gender?: "male" | "female" | null,
): OnlineStatusDescriptor => {
  if (!lastSeenAt) {
    return {
      label: 'оффлайн',
      badgeClass: 'text-slate-100/90',
      title: 'Статус ещё не получен',
      isOnline: false,
      style: { backgroundColor: 'rgba(71, 85, 105, 0.55)', border: '1px solid rgba(148, 163, 184, 0.35)' },
    };
  }
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) {
    return {
      label: 'оффлайн',
      badgeClass: 'text-slate-100/90',
      title: 'Некорректное значение статуса',
      isOnline: false,
      style: { backgroundColor: 'rgba(71, 85, 105, 0.55)', border: '1px solid rgba(148, 163, 184, 0.35)' },
    };
  }
  const diff = Date.now() - timestamp;
  const title = `Последний визит: ${new Date(timestamp).toLocaleString('ru-RU')}`;
  if (diff <= ONLINE_THRESHOLD_MS) {
    return {
      label: 'онлайн',
      badgeClass: 'text-emerald-50 shadow-[0_0_6px_rgba(16,185,129,0.35)]',
      title,
      isOnline: true,
      style: { background: 'linear-gradient(120deg, rgba(16, 185, 129, 0.7), rgba(5, 150, 105, 0.8))', border: '1px solid rgba(52, 211, 153, 0.6)' },
    };
  }
  const recent = diff < HOUR_MS;
  const verb = gender === "female" ? "была" : "был";
  const agoLabel = formatAgoLabel(diff);
  return {
    label: agoLabel === "давно" ? `${verb} ${agoLabel}` : `${verb} ${agoLabel} назад`,
    badgeClass: recent
      ? 'text-amber-50'
      : 'text-slate-200/80',
    title,
    isOnline: false,
    style: recent
      ? { background: 'linear-gradient(120deg, rgba(251, 191, 36, 0.55), rgba(245, 158, 11, 0.65))', border: '1px solid rgba(251, 191, 36, 0.6)' }
      : { backgroundColor: 'rgba(100, 116, 139, 0.55)', border: '1px solid rgba(148, 163, 184, 0.35)' },
  };
};
const OTHER_PROFILES_CACHE_KEY = 'synastry_cached_other_profiles_v1';
const OTHER_PROFILES_PAGE_SIZE = 25;
const OTHER_PROFILES_CACHE_MAX = 100;
const PROFILE_LOAD_ERROR_MESSAGE = 'Не удалось загрузить профиль. Проверьте соединение или активность проекта Supabase.';
const EMPTY_SMALL_PHOTOS: (string | null)[] = [null, null];
function normalizeSmallPhotosField(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) {
    return [...EMPTY_SMALL_PHOTOS];
  }
  const normalized = value.slice(0, 2).map((item) => (typeof item === 'string' && item.trim() ? item : null));
  while (normalized.length < 2) {
    normalized.push(null);
  }
  return normalized;
}
function mergeProfileSnapshots(
  primary: Partial<UserProfile> | Record<string, unknown> | null | undefined,
  secondary: Partial<UserProfile> | Record<string, unknown> | null | undefined,
): UserProfile | null {
  const result: UserProfile = {
    personName: '',
    lastName: '',
    birth: '',
    selectedCity: '',
    cityNameRu: '',
    mainPhoto: null,
    smallPhotos: [...EMPTY_SMALL_PHOTOS],
    typeazh: '',
    familyStatus: '',
    about: '',
    interests: '',
    religion: '',
    career: '',
    children: '',
    profession: '',
  };
  const seen = new Set<object>();
  const assignStringField = (key: keyof UserProfile, value: unknown) => {
    if (typeof value !== 'string') return;
    // Variant A: empty string is an explicit "clear", so it must be able to override non-empty values.
    (result as Record<string, unknown>)[key] = value;
  };
  const assignMainPhoto = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      result.mainPhoto = value;
    }
  };
  const assignSmallPhotos = (value: unknown) => {
    const normalized = normalizeSmallPhotosField(value);
    const hasPhotos = normalized.some((item) => typeof item === 'string' && item.trim());
    const currentHas = result.smallPhotos.some((item) => typeof item === 'string' && item.trim());
    if (hasPhotos || !currentHas) {
      result.smallPhotos = normalized;
    }
  };
  const assignGender = (value: unknown) => {
    const g = normalizeGender(value);
    if (g) result.gender = g;
  };
  const assignAscSign = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      result.ascSign = value;
    }
  };
  const firstString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string') {
        return candidate;
      }
    }
    return undefined;
  };
  const applyRecord = (record: Record<string, unknown>) => {
    if (seen.has(record)) return;
    seen.add(record);
    if (isRecord(record.profile)) {
      applyRecord(record.profile);
    }
    assignStringField('personName', firstString(record, ['personName', 'firstName', 'name']));
    assignStringField('lastName', firstString(record, ['lastName', 'surname', 'secondName']));
    assignStringField('birth', firstString(record, ['birth', 'birthDate', 'birth_iso', 'datetime_iso']));
    assignStringField('selectedCity', firstString(record, ['selectedCity', 'cityName', 'city', 'cityQuery']));
    assignStringField('cityNameRu', firstString(record, ['cityNameRu', 'cityRu']));
    assignStringField('residenceCountry', firstString(record, ['residenceCountry']));
    assignStringField('residenceCityName', firstString(record, ['residenceCityName', 'residenceCity', 'residence_city']));
    assignStringField('typeazh', record.typeazh);
    assignStringField('familyStatus', record.familyStatus);
    assignStringField('about', record.about);
    assignStringField('interests', record.interests);
    assignStringField('religion', record.religion);
    assignStringField('career', record.career);
    assignStringField('children', record.children);
    assignStringField('profession', record.profession);
    assignMainPhoto(record.mainPhoto ?? record.photo ?? record.avatar);
    assignSmallPhotos(record.smallPhotos ?? record.photos ?? record.thumbnails);
    assignGender(record.gender);
    if (isRecord(record.ascendant) && typeof record.ascendant.sign === 'string') {
      assignAscSign(record.ascendant.sign);
    }
    assignAscSign(record.ascSign);
  };
  if (primary && typeof primary === 'object') {
    applyRecord(primary as Record<string, unknown>);
  }
  if (secondary && typeof secondary === 'object') {
    applyRecord(secondary as Record<string, unknown>);
  }
  const hasPhotos = Boolean(result.mainPhoto) || result.smallPhotos.some((item) => typeof item === 'string' && item.trim());
  const hasText = [
    result.personName,
    result.lastName,
    result.birth,
    result.selectedCity,
    result.typeazh,
    result.familyStatus,
    result.about,
    result.interests,
    result.religion,
    result.career,
    result.children,
    result.profession,
  ].some((value) => typeof value === 'string' && value.trim());
  if (!hasPhotos && !hasText && !result.gender && !result.ascSign) {
    return null;
  }
  result.smallPhotos = normalizeSmallPhotosField(result.smallPhotos);
  if ((!result.cityNameRu || !result.cityNameRu.trim()) && result.selectedCity) {
    result.cityNameRu = latinToRuName(result.selectedCity);
  }
  return result;
}
const restoreCachedOtherProfile = (value: unknown): OtherProfilePreview | null => {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const record = value as Record<string, unknown>;
  const personName = typeof value.personName === 'string' ? value.personName : '';
  const lastName = typeof value.lastName === 'string' ? value.lastName : '';
  const selectedCity = typeof value.selectedCity === 'string' ? value.selectedCity : '';
  const cityNameRuRaw = readStringProp(record, 'cityNameRu');
  const cityNameRu = cityNameRuRaw || (selectedCity ? latinToRuName(selectedCity) : '');
  const residenceCountry = readStringProp(record, 'residenceCountry');
  const residenceCityName = readStringProp(record, 'residenceCityName');
  const mainPhoto = typeof value.mainPhoto === 'string' ? value.mainPhoto : null;
  const smallPhotos = normalizeSmallPhotosField(record.smallPhotos ?? record.photos ?? record.thumbnails ?? (value as Record<string, unknown>).smallPhotos);
  const birth = typeof value.birth === 'string' ? value.birth : null;
  const ascSign = typeof value.ascSign === 'string' ? value.ascSign : null;
  const chartScreenshot = typeof value.chartScreenshot === 'string' ? value.chartScreenshot : null;
  const gender = normalizeGender(value.gender);
  const typeazh = typeof value.typeazh === 'string' ? value.typeazh : '';
  const familyStatus = readStringProp(record, 'familyStatus');
  const about = readStringProp(record, 'about');
  const interests = readStringProp(record, 'interests');
  const religion = readStringProp(record, 'religion');
  const career = readStringProp(record, 'career');
  const profession = readStringProp(record, 'profession');
  const children = readStringProp(record, 'children');
  let chart: ChartPayload = null;
  if (value.chart === null) {
    chart = null;
  } else if (isRecord(value.chart)) {
    chart = value.chart as Record<string, unknown>;
  }
  const chartSignature = computeChartSignature(chart);
  const lastSeenAt =
    typeof record.lastSeenAt === 'string'
      ? record.lastSeenAt
      : typeof record.last_seen_at === 'string'
        ? record.last_seen_at
        : null;
  return {
    id: value.id,
    personName,
    lastName,
    selectedCity,
    cityNameRu,
    residenceCountry,
    residenceCityName,
    mainPhoto,
    smallPhotos,
    birth,
    ascSign,
    chartScreenshot,
    gender,
    typeazh,
    familyStatus,
    about,
    interests,
    religion,
    career,
    profession,
    children,
    chart,
    chartSignature,
    lastSeenAt,
  };
};
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}

const computeChartSignature = (chart: ChartPayload): string | null => {
  if (!chart) return null;
  try {
    return stableStringify(chart);
  } catch (error) {
    console.warn('Failed to compute chart signature', error);
    return null;
  }
};
// Build a person identity fingerprint using core fields. If these change, it's a different person.
function personFingerprint(p: Partial<UserProfile> | null | undefined): string {
  if (!p) return "";
  const name = (p.personName ?? "").trim().toLowerCase();
  const last = (p.lastName ?? "").trim().toLowerCase();
  const birth = (p.birth ?? "").trim();
  const city = (p.selectedCity ?? "").trim().toLowerCase();
  return [name, last, birth, city].join('|');
}
function calculateAge(birthIso: string | null): number | null {
  if (!birthIso) return null;
  const parsed = new Date(birthIso);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - parsed.getFullYear();
  const monthDiff = now.getMonth() - parsed.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < parsed.getDate())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

function formatAgeRu(age: number): string {
  const value = Math.trunc(age);
  const mod10 = Math.abs(value) % 10;
  const mod100 = Math.abs(value) % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? 'год' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'года' : 'лет';
  return `${value} ${word}`;
}
  const UserProfilePage: React.FC = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [chart, setChart] = useState<ChartRow | null>(null);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [otherProfilePhotoIndex, setOtherProfilePhotoIndex] = useState(0);
  const [identityEmail, setIdentityEmail] = useState<string | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<ElectronLicenseStatus | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const viewingOwnProfile = useMemo(() => Boolean(currentUserId && userId && currentUserId === userId), [currentUserId, userId]);
  const [otherProfiles, setOtherProfiles] = useState<OtherProfilePreview[]>([]);
  const [otherLoading, setOtherLoading] = useState(true);
  const [otherLoadingMore, setOtherLoadingMore] = useState(false);
  const [otherHasMore, setOtherHasMore] = useState(true);
  const otherProfilesRef = useRef<OtherProfilePreview[]>([]);
  const otherPagingOffsetRef = useRef(0);
  const otherPagingHasMoreRef = useRef(true);
  const otherPagingSeqRef = useRef(0);
  const otherPagingInFlightRef = useRef(false);
  const otherLoadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const [selectedOtherProfileId, setSelectedOtherProfileId] = useState<string | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [profileRetryTick, setProfileRetryTick] = useState(0);
  const [compatibilityMap, setCompatibilityMap] = useState<Record<string, CompatibilityPreview>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const clearedUnreadRef = useRef<Record<string, number>>({});
  const clearedUnreadUserRef = useRef<string | null>(null);
  const compatibilityRef = useRef<Record<string, CompatibilityPreview>>({});
  const { isOnline } = useNetStatus();
  const location = useLocation();
  const params = new URLSearchParams(location.search || '');
  const arrivedFromFile = params.get('fromFile') === '1';
  const fromFileSession = isChartSessionFromFile();
  const fromFileRef = useRef(arrivedFromFile || fromFileSession);
  const cachedOwnerId = useChartCache((state) => state.ownerId);
  const cachedProfileRecord = useChartCache((state) => state.profile);
  const cachedChartRecord = useChartCache((state) => state.chart);
  const blocklistEntries = useBlocklistStore((state) => state.entries);
  const blockedKeys = useMemo(() => Object.keys(blocklistEntries), [blocklistEntries]);
  const blockedIds = useMemo(() => new Set(blockedKeys), [blockedKeys]);
  const blockedIdsRef = useRef<Set<string>>(new Set());
  const selfGender = useMemo(() => normalizeGender(profile?.gender), [profile?.gender]);
  const oppositeGender = useMemo(() => {
    if (selfGender === 'male') return 'female';
    if (selfGender === 'female') return 'male';
    return null;
  }, [selfGender]);
  const selectedOtherProfile = useMemo(
    () => (selectedOtherProfileId ? otherProfiles.find((entry) => entry.id === selectedOtherProfileId) ?? null : null),
    [otherProfiles, selectedOtherProfileId],
  );
  useEffect(() => {
    otherProfilesRef.current = otherProfiles;
  }, [otherProfiles]);
  useEffect(() => {
    otherPagingHasMoreRef.current = otherHasMore;
  }, [otherHasMore]);
  useEffect(() => {
    blockedIdsRef.current = blockedIds;
  }, [blockedIds]);

  const isProfileLoadError = loadingError === PROFILE_LOAD_ERROR_MESSAGE;
  useEffect(() => {
    if (!isProfileLoadError) return;
    const timer = window.setInterval(() => {
      setProfileRetryTick((value) => value + 1);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [isProfileLoadError]);

  useEffect(() => {
    setOtherProfilePhotoIndex(0);
  }, [selectedOtherProfileId]);
  const visibleOtherProfiles = useMemo(() => {
    const blockedSet = blockedKeys.length ? new Set(blockedKeys) : null;
    const base = blockedSet ? otherProfiles.filter((entry) => !blockedSet.has(entry.id)) : otherProfiles;
    if (!selfGender) return [];
    return base.filter((entry) => entry.gender && entry.gender !== selfGender);
  }, [blockedKeys, otherProfiles, selfGender]);
  const requestPurchaseDialog = useCallback(() => {
    try {
      const api = typeof window !== 'undefined' ? window.electronAPI?.license : undefined;
      if (api?.requestPrompt) {
        void api.requestPrompt();
      } else if (api?.purchase) {
        void api.purchase();
      }
    } catch (error) {
      console.warn('Не удалось открыть окно покупки лицензии', error);
    }
  }, []);
  const partnerActionsAllowed = useMemo(() => {
    if (!licenseStatus) return true;
    if (licenseStatus.licensed || licenseStatus.allowed) return true;
    const trialDays = licenseStatus.trial?.daysLeft;
    return typeof trialDays === 'number' ? trialDays > 0 : true;
  }, [licenseStatus]);
  const partnerActionsLocked = !partnerActionsAllowed;
  const requestPartnerActionsAccess = useCallback(() => {
    requestPurchaseDialog();
  }, [requestPurchaseDialog]);
  useEffect(() => {
    if (!partnerActionsLocked) return;
    if (!selectedOtherProfileId) return;
    requestPurchaseDialog();
    setSelectedOtherProfileId(null);
  }, [partnerActionsLocked, requestPurchaseDialog, selectedOtherProfileId]);
  const photoUrls = useMemo(() => {
    const urls: string[] = [];
    const main = typeof profile?.mainPhoto === 'string' ? profile.mainPhoto.trim() : '';
    if (main) urls.push(main);
    const small = profile?.smallPhotos;
    if (Array.isArray(small)) {
      for (const value of small) {
        const url = typeof value === 'string' ? value.trim() : '';
        if (url) urls.push(url);
      }
    }
    return urls;
  }, [profile?.mainPhoto, profile?.smallPhotos]);
  useEffect(() => {
    setPhotoIndex(0);
  }, [userId, profile?.mainPhoto, profile?.smallPhotos]);
  useEffect(() => {
    setPhotoIndex((current) => {
      const maxIndex = Math.max(0, photoUrls.length - 1);
      return Math.min(Math.max(0, current), maxIndex);
    });
  }, [photoUrls.length]);
  useEffect(() => {
    clearedUnreadUserRef.current = currentUserId ?? null;
    if (!currentUserId) {
      clearedUnreadRef.current = {};
      return;
    }
    clearedUnreadRef.current = readClearedUnreadFromStorage(currentUserId);
  }, [currentUserId]);
  const refreshUnreadCounts = useCallback(async () => {
    if (!currentUserId) {
      setUnreadCounts({});
      return;
    }
    if (!isOnline) return;
    try {
      const { data, error } = await supabase
        .from(CHAT_TABLE)
        .select('sender_id, created_at')
        .eq('recipient_id', currentUserId)
        .is('read_at', null);
      if (error) throw error;
      const next: Record<string, number> = {};
      const clearedMap = clearedUnreadRef.current;
      for (const row of (data ?? []) as Array<{ sender_id: string | null; created_at: string | null }>) {
        if (typeof row.sender_id !== 'string') continue;
        const createdAt = parseTimestamp(row.created_at);
        const clearedAt = clearedMap[row.sender_id];
        if (clearedAt && createdAt > 0 && createdAt <= clearedAt) {
          continue;
        }
        next[row.sender_id] = (next[row.sender_id] ?? 0) + 1;
      }
      setUnreadCounts(next);
    } catch (error) {
      console.warn('Не удалось загрузить непрочитанные сообщения', error);
    }
  }, [currentUserId, isOnline]);
  const sanitizeOwnProfile = useCallback(
    (candidate: UserProfile | null) => {
      if (!candidate) return null;
      if (!currentUserId || !userId) return candidate;
      if (currentUserId === userId) return candidate;
      return (stripResidenceFields(candidate) ?? candidate) as UserProfile;
    },
    [currentUserId, userId],
  );
  const chartCacheRef = useRef<{
    ownerId: string | null;
    profile: Record<string, unknown> | null;
    chart: Record<string, unknown> | null;
  }>({
    ownerId: cachedOwnerId,
    profile: cachedProfileRecord,
    chart: cachedChartRecord,
  });
  useEffect(() => {
    chartCacheRef.current = {
      ownerId: cachedOwnerId,
      profile: cachedProfileRecord,
      chart: cachedChartRecord,
    };
  }, [cachedOwnerId, cachedProfileRecord, cachedChartRecord, sanitizeOwnProfile]);
  useEffect(() => {
    if (arrivedFromFile) {
      fromFileRef.current = true;
    }
  }, [arrivedFromFile]);
  const getCityLabel = useCallback((cityRu?: string | null, city?: string | null) => {
    const ru = typeof cityRu === 'string' ? cityRu.trim() : '';
    const base = typeof city === 'string' ? city.trim() : '';
    return ru || base || '';
  }, []);
  const encodeChatPayload = useCallback((entry: OtherProfilePreview): string | null => {
    try {
      const payload = {
        id: entry.id,
        personName: entry.personName || '',
        lastName: entry.lastName || '',
        cityNameRu: entry.cityNameRu || '',
        selectedCity: entry.selectedCity || '',
        gender: entry.gender || null,
        mainPhoto: entry.mainPhoto || null,
      };
      const json = JSON.stringify(payload);
      if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
        const encoded = window.btoa(
          encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_match, p1) =>
            String.fromCharCode(parseInt(p1, 16))
          )
        );
        return encodeURIComponent(encoded);
      }
      if (typeof Buffer !== 'undefined') {
        return encodeURIComponent(Buffer.from(json, 'utf-8').toString('base64'));
      }
    } catch (error) {
      console.warn('Не удалось подготовить данные для чата', error);
    }
    return null;
  }, []);
  const optimisticClearUnread = useCallback((profileId: string) => {
    setUnreadCounts((prev) => {
      if (!prev[profileId]) return prev;
      const next = { ...prev };
      delete next[profileId];
      return next;
    });
    if (currentUserId) {
      const nextCleared = { ...clearedUnreadRef.current, [profileId]: Date.now() };
      clearedUnreadRef.current = nextCleared;
      writeClearedUnreadToStorage(currentUserId, nextCleared);
    }
  }, [currentUserId]);

  const markMessagesRead = useCallback((profileId: string) => {
    if (!currentUserId) return;
    const nowIso = new Date().toISOString();
    void (async () => {
      try {
        await supabase
          .from(CHAT_TABLE)
          .update({ read_at: nowIso })
          .is('read_at', null)
          .eq('recipient_id', currentUserId)
          .eq('sender_id', profileId);
      } catch (error) {
        console.warn('Не удалось отметить сообщения прочитанными из профиля', error);
      }
    })();
  }, [currentUserId]);

  const handleOpenChat = useCallback((entry: OtherProfilePreview) => {
    if (!selfGender) {
      setLoadingError('Укажите пол в анкете, чтобы открыть чат.');
      return;
    }
    const entryGender = normalizeGender(entry.gender);
    if (!entryGender || entryGender === selfGender) {
      setLoadingError('Чат доступен только с противоположным полом.');
      return;
    }
    if (partnerActionsLocked) {
      requestPartnerActionsAccess();
      return;
    }
    if (blockedIds.has(entry.id)) {
      setLoadingError('Чат недоступен: пользователь в вашем блок-листе.');
      return;
    }
    optimisticClearUnread(entry.id);
    markMessagesRead(entry.id);
    if (typeof window === 'undefined') return;
    const encoded = encodeChatPayload(entry);
    if (!encoded) return;
    const api = window.electronAPI?.chat;
    if (api?.open) {
      api.open(encoded);
      return;
    }
    const [base] = window.location.href.split('#');
    const url = `${base || window.location.href}#/chat-popup?data=${encoded}`;
    window.open(url, `chat-${entry.id}`, 'width=520,height=640,resizable=yes,menubar=no,toolbar=no')?.focus();
  }, [blockedIds, encodeChatPayload, markMessagesRead, optimisticClearUnread, partnerActionsLocked, requestPartnerActionsAccess, selfGender]);
  // Получаем email пользователя из Electron (main) и показываем под именем
  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      const api = (typeof window !== 'undefined') ? window.electronAPI?.license : undefined;
      if (api?.getStatus) {
        api.getStatus().then((s: ElectronLicenseStatus | null) => {
          setLicenseStatus(s ?? null);
          setIdentityEmail(s?.identityEmail ?? null);
        }).catch((error) => {
          console.warn('Не удалось получить статус лицензии из Electron', error);
        });
      }
      if (api?.onStatus) {
        unsub = api.onStatus((s: ElectronLicenseStatus | null) => {
          setLicenseStatus(s ?? null);
          setIdentityEmail(s?.identityEmail ?? null);
        });
      }
    } catch (error) {
      console.warn('Не удалось подписаться на статус лицензии', error);
    }
    return () => {
      try {
        unsub?.();
      } catch (error) {
        console.warn('Не удалось снять подписку на статус лицензии', error);
      }
    };
  }, []);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    supabase.auth
      .getUser()
      .then(({ data }) => setCurrentUserId(data?.user?.id ?? null))
      .catch(() => setCurrentUserId(null));
    try {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        setCurrentUserId(session?.user?.id ?? null);
      });
      subscription = data?.subscription;
    } catch (error) {
      console.warn('Не удалось подписаться на изменение авторизации', error);
    }
    return () => {
      try {
        subscription?.unsubscribe();
      } catch (error) {
        console.warn('Не удалось отменить подписку на изменение авторизации', error);
      }
    };
  }, []);

  useEffect(() => {
    if (!currentUserId) {
      setUnreadCounts({});
      return;
    }
    if (!isOnline) {
      setUnreadCounts({});
      return;
    }
    void refreshUnreadCounts();
    const channel = supabase
      .channel(`unread-watch-${currentUserId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: CHAT_TABLE, filter: `recipient_id=eq.${currentUserId}` },
        () => {
          void refreshUnreadCounts();
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: CHAT_TABLE, filter: `recipient_id=eq.${currentUserId}` },
        () => {
          void refreshUnreadCounts();
        },
      );
    channel.subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch (error) {
        console.warn('Не удалось убрать канал непрочитанных сообщений', error);
      }
    };
  }, [currentUserId, isOnline, refreshUnreadCounts]);

  const updateCompatibilityMap = useCallback((updater: (prev: Record<string, CompatibilityPreview>) => Record<string, CompatibilityPreview>) => {
    setCompatibilityMap((prev) => {
      const next = updater(prev);
      compatibilityRef.current = next;
      return next;
    });
  }, []);
  useEffect(() => {
    updateCompatibilityMap(() => ({}));
  }, [userId, updateCompatibilityMap]);
  useEffect(() => {
    updateCompatibilityMap(() => ({}));
  }, [chart, updateCompatibilityMap]);
  useEffect(() => {
    let cancelled = false;
    const chartValue = chart?.chart;
    if (!isRecord(chartValue)) return () => {
      cancelled = true;
    };
    if (chartValue.screenshotResolved) {
      return () => {
        cancelled = true;
      };
    }
    const pointer = typeof chartValue.screenshotStoragePointer === 'string' ? chartValue.screenshotStoragePointer : null;
    const rawUrl = typeof chartValue.screenshotUrl === 'string' ? chartValue.screenshotUrl : null;
    const raw = pointer ?? rawUrl;
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) {
      return () => {
        cancelled = true;
      };
    }
    if (!needsSupabaseResolution(raw)) {
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      const resolved = await resolveSupabaseScreenshotUrl(pointer ?? raw);
      if (cancelled || !resolved) return;
      const suppressBrokenPublic = /\/storage\/v1\/object\/public\/charts-screenshots\//.test(raw) && resolved === raw;
      setChart((prev) => {
        if (!prev || !isRecord(prev.chart)) return prev;
        if (prev.chart?.screenshotResolved) return prev;
        const nextChart: Record<string, unknown> = { ...prev.chart, screenshotResolved: true };
        if (suppressBrokenPublic) {
          nextChart.screenshotUrl = null;
        } else {
          nextChart.screenshotUrl = resolved;
        }
        return { ...prev, chart: nextChart };
      });
    })().catch((err) => {
      console.warn('Failed to resolve profile screenshot', err);
    });
    return () => {
      cancelled = true;
    };
  }, [chart]);
  useEffect(() => {
    let cancelled = false;
    const preferLocalSession = Boolean(fromFileRef.current && viewingOwnProfile);
    async function loadData() {
      if (!userId) return;
      
      try {
        if (!cancelled) setLoadingError(null);
        // Мгновенная загрузка из localStorage (если есть) - отображаем сразу
        let localInitialProfile: UserProfile | null = null;
        if (viewingOwnProfile) {
          try {
            const stored = readProfileFromStorage<Partial<UserProfile> | Record<string, unknown>>(STORAGE_KEY);
            if (stored && isOwnerMatch(stored.ownerId, currentUserId)) {
              const snapshotSource = stored.profile ?? stored.raw;
              if (snapshotSource && typeof snapshotSource === 'object') {
                const normalized = mergeProfileSnapshots(snapshotSource as Record<string, unknown>, null);
                if (normalized) {
                  localInitialProfile = normalized;
                }
              }
            }
          } catch (error) {
            console.warn('Failed to read local profile snapshot', error);
          }
        }
        const localInitialFp = personFingerprint(localInitialProfile);
        let resolvedLocalScreenshot: string | null = null;
        const captureScreenshotSource = (source: unknown, options?: { force?: boolean }) => {
          if (!source) return;
          if (!options?.force && resolvedLocalScreenshot) return;
          const shot = resolveScreenshotFromAny(source);
          if (shot) {
            resolvedLocalScreenshot = shot;
          }
        };
        let savedChartRecord: SavedChartRecord<Record<string, unknown>> | null = null;
        if (viewingOwnProfile) {
          try {
            savedChartRecord = readSavedChart<Record<string, unknown>>(currentUserId ?? undefined);
          } catch (storageError) {
            console.warn('Failed to read saved chart record', storageError);
          }
        }
        const savedChartMeta = savedChartRecord?.meta ?? null;
        let savedChartPayload: Record<string, unknown> | null = null;
        if (savedChartRecord) {
          if (savedChartRecord.payload && isRecord(savedChartRecord.payload)) {
            savedChartPayload = savedChartRecord.payload;
          } else if (savedChartRecord.raw && isRecord(savedChartRecord.raw)) {
            savedChartPayload = savedChartRecord.raw as Record<string, unknown>;
          }
        }
        if (!savedChartPayload && viewingOwnProfile) {
          savedChartPayload = readSavedChartSource(currentUserId ?? undefined);
        }
        // Fallback to in-memory cache only when we are not in a file session and no local saved record exists.
        if (!savedChartPayload && viewingOwnProfile && !preferLocalSession) {
          const cacheSnapshot = chartCacheRef.current;
          const hasMatchingCache = Boolean(cacheSnapshot?.ownerId && cacheSnapshot.ownerId === currentUserId);
          if (hasMatchingCache && (cacheSnapshot?.chart || cacheSnapshot?.profile)) {
            savedChartPayload = {};
            if (cacheSnapshot?.chart) {
              savedChartPayload.chart = cacheSnapshot.chart;
              captureScreenshotSource(cacheSnapshot.chart);
            }
            if (cacheSnapshot?.profile) savedChartPayload.profile = cacheSnapshot.profile;
          }
        }
        if (savedChartPayload) {
          captureScreenshotSource(savedChartPayload['chart'], { force: true });
          if (!resolvedLocalScreenshot) {
            captureScreenshotSource(savedChartPayload, { force: true });
          }
        } else if (viewingOwnProfile) {
          try {
            const fallbackSource = readSavedChartSource(currentUserId ?? undefined);
            if (fallbackSource) {
              captureScreenshotSource(fallbackSource['chart'] ?? fallbackSource, { force: true });
            }
          } catch (resolveError) {
            console.warn('Failed to resolve screenshot from saved chart source', resolveError);
          }
        }

        let localSavedChartProfile: UserProfile | null = null;
        if (savedChartPayload) {
          try {
            const chartCandidate = savedChartPayload['chart'] as unknown;
            if (chartCandidate && typeof chartCandidate === 'object') {
              const normalizedChart = isRecord(chartCandidate) ? chartCandidate : null;
              if (normalizedChart) {
                if (!cancelled) setChart((prev) => {
                  if (!prev) return toChartRow({ chart: normalizedChart });
                  const nextSignature = computeChartSignature(normalizedChart as ChartPayload);
                  const prevSignature = computeChartSignature(extractChartPayload(prev));
                  if (!prevSignature || prevSignature !== nextSignature) {
                    return toChartRow({ chart: normalizedChart });
                  }
                  return prev;
                });
              }
            }
            const savedProfileRaw = savedChartPayload['profile'] as unknown;
            if (isRecord(savedProfileRaw)) {
              localSavedChartProfile = mergeProfileSnapshots(savedProfileRaw, null);
            }
          } catch (e) {
            console.warn('Failed to read saved chart cache', e);
          }
        }
        const localSavedChartFp = personFingerprint(localSavedChartProfile);
        if (localSavedChartProfile) {
          const preferChartProfile =
            preferLocalSession ||
            !localInitialProfile ||
            !localInitialFp ||
            (localSavedChartFp && localInitialFp && localSavedChartFp !== localInitialFp);
          if (preferChartProfile) {
            if (!cancelled) setProfile(sanitizeOwnProfile(localSavedChartProfile));
          }
        }
        if (!isOnline) {
          return;
        }
        // Load profile data
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('data')
          .eq('id', userId)
          .single();
          
        if (cancelled) return;
        if (profileError) throw profileError;
        const normalizedCloudProfile = mergeProfileSnapshots(null, profileData?.data as Record<string, unknown>);
        if (!normalizedCloudProfile) {
          if (!cancelled) setProfile(sanitizeOwnProfile(localSavedChartProfile));
          if (!localSavedChartProfile) {
            if (!cancelled) setLoadingError('Профиль пользователя не найден.');
            return;
          }
        }
        const cloudFp = personFingerprint(normalizedCloudProfile);
        const savedChartFp = personFingerprint(localSavedChartProfile);
        const chartOverridesCloud = Boolean(
          localSavedChartProfile && (preferLocalSession || (savedChartFp && cloudFp && savedChartFp !== cloudFp))
        );
        let effectiveProfile: UserProfile | null = null;
        if (preferLocalSession && localSavedChartProfile) {
          effectiveProfile =
            mergeProfileSnapshots(normalizedCloudProfile, localSavedChartProfile) ?? localSavedChartProfile;
        } else if (chartOverridesCloud && localSavedChartProfile) {
          effectiveProfile = localSavedChartProfile;
        } else if (localInitialProfile) {
          effectiveProfile =
            mergeProfileSnapshots(localInitialProfile, profileData?.data as Record<string, unknown>) ?? normalizedCloudProfile ?? localSavedChartProfile;
        } else {
          effectiveProfile = normalizedCloudProfile ?? localSavedChartProfile;
        }
        if (!cancelled) setProfile(sanitizeOwnProfile(effectiveProfile));
        // Load latest chart (optional)
        const { data: chartData, error: chartError } = await supabase
          .from('charts')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        if (chartError && chartError.code !== 'PGRST116') {
          console.warn('Error loading latest chart:', chartError);
        }
        const localChartValue = savedChartPayload && isRecord(savedChartPayload['chart']) ? savedChartPayload['chart'] : null;
        if (localChartValue) {
          captureScreenshotSource(localChartValue);
        }
        const localChartRow = localChartValue ? toChartRow({ chart: localChartValue as Record<string, unknown> }) : null;
        const localChartUpdatedAt = savedChartMeta?.updatedAt ?? 0;
        const remoteChartUpdatedAt = chartData && isRecord(chartData)
          ? parseTimestamp((chartData as Record<string, unknown>).updated_at ?? (chartData as Record<string, unknown>).created_at)
          : 0;
        const preferLocalChartRow = Boolean(
          localChartRow && (preferLocalSession || localChartUpdatedAt > remoteChartUpdatedAt),
        );
        let finalChart: ChartRow | null = null;
        if (preferLocalChartRow && localChartRow) {
          finalChart = localChartRow;
        } else if (chartData) {
          finalChart = toChartRow(chartData);
        } else if (localChartRow) {
          finalChart = localChartRow;
        }
        if (finalChart) {
          try {
            const localShot: string | null = resolvedLocalScreenshot;
            const normalizedLocalShot = localShot ? String(localShot).trim() : '';
            const hasLocalShot = normalizedLocalShot.length > 0;
            const finalHasShot = extractChartScreenshot(finalChart);
            if (
              hasLocalShot &&
              normalizedLocalShot &&
              (preferLocalSession || !finalHasShot || localChartUpdatedAt > remoteChartUpdatedAt)
            ) {
              finalChart = applyScreenshotToChart(finalChart, normalizedLocalShot);
            }
            if (!extractChartScreenshot(finalChart)) {
              try {
                const preferredBuckets = ['charts-screenshots', 'charts', 'public', 'screenshots'];
                for (const bucket of preferredBuckets) {
                  try {
                    const { data: listData, error: listError } = await supabase.storage.from(bucket).list('', { limit: 100 });
                    if (listError || !Array.isArray(listData)) {
                      continue;
                    }
                    const match = listData.find((item) => isRecord(item) && typeof item.name === 'string' && item.name.startsWith(`chart-${userId}-`));
                    if (match) {
                      const pointer = encodeSupabasePointer({ bucket, path: match.name });
                      const resolved = await resolveSupabaseScreenshotUrl(pointer);
                      if (resolved) {
                        finalChart = applyScreenshotToChart(finalChart, resolved);
                        break;
                      }
                    }
                  } catch (bucketError) {
                    console.warn('Error listing bucket', bucket, bucketError);
                  }
                }
              } catch (storageError) {
                console.warn('Error trying to find screenshot in storage buckets', storageError);
              }
            }
          } catch (resolutionError) {
            console.warn('Failed to resolve chart screenshot', resolutionError);
          }
        }
        // Не подменяем локально открытую карту чужой из облака (если другой человек)
        // Не подменяем локально открытую карту облачной, если это другой человек
        if (finalChart) {
          const savedFp = personFingerprint(localSavedChartProfile);
          const cloudPersonFp = personFingerprint(normalizedCloudProfile);
          const localChartCandidate = savedChartPayload?.chart;
          const hasLocalFileChart = Boolean(localChartCandidate && isRecord(localChartCandidate));
          const shouldSkipOverride = Boolean(
            (preferLocalSession && hasLocalFileChart) ||
              (viewingOwnProfile && savedFp && cloudPersonFp && savedFp !== cloudPersonFp)
          );
          const profileForCache =
            chartOverridesCloud && localSavedChartProfile
              ? localSavedChartProfile
              : (effectiveProfile ?? normalizedCloudProfile ?? localSavedChartProfile);
          const finalChartPayload = extractChartPayload(finalChart);
          const finalChartFingerprint = computeChartSignature(finalChartPayload);
          const cacheUpdatedAt = preferLocalChartRow
            ? localChartUpdatedAt || Date.now()
            : remoteChartUpdatedAt || Date.now();
          const fallbackLocalSource: SavedChartSource = preferLocalSession ? 'file' : 'local';
          const cacheSource: SavedChartSource = preferLocalChartRow
            ? savedChartMeta?.source ?? fallbackLocalSource
            : 'cloud';
          if (!shouldSkipOverride) {
            if (viewingOwnProfile) {
              try {
                const chartCachePayload = {
                  ...finalChart,
                  profile: profileForCache,
                  cachedAt: Date.now(),
                };
                writeSavedChart(chartCachePayload, currentUserId ?? null, {
                  meta: {
                    source: cacheSource,
                    updatedAt: cacheUpdatedAt,
                    fingerprint: finalChartFingerprint,
                  },
                });
              } catch (chartCacheError) {
                console.warn('Не удалось сохранить карту в локальный кеш', chartCacheError);
              }
            }
            if (!cancelled) setChart(finalChart);
          }
        }
      } catch (e) {
        console.error('Error loading profile:', e);
        if (!cancelled) {
          setLoadingError(PROFILE_LOAD_ERROR_MESSAGE);
        }
      }
    }
    void loadData();
    return () => {
      cancelled = true;
    };
  }, [userId, currentUserId, isOnline, sanitizeOwnProfile, viewingOwnProfile, profileRetryTick]);
  const loadOtherProfilesPage = useCallback(
    async ({ reset }: { reset: boolean }) => {
      const seq = ++otherPagingSeqRef.current;
      if (!reset && (!otherPagingHasMoreRef.current || otherPagingInFlightRef.current)) return;

      if (reset) {
        otherPagingOffsetRef.current = 0;
        otherPagingHasMoreRef.current = true;
        setOtherHasMore(true);
        setOtherProfiles([]);
      }

      if (reset) {
        setOtherLoading(true);
        setOtherLoadingMore(false);
      } else {
        setOtherLoadingMore(true);
      }

      otherPagingInFlightRef.current = true;
      try {
        if (!isOnline) {
          try {
            const raw = localStorage.getItem(OTHER_PROFILES_CACHE_KEY);
            if (raw) {
              const parsed = JSON.parse(raw) as unknown;
              if (isRecord(parsed) && Array.isArray(parsed.entries)) {
                let cached = parsed.entries
                  .map((entry) => restoreCachedOtherProfile(entry))
                  .filter((item): item is OtherProfilePreview => Boolean(item));
                if (oppositeGender) {
                  cached = cached.filter((p) => p.gender === oppositeGender);
                }
                const blockedSet = blockedIdsRef.current;
                const filteredCached = blockedSet.size ? cached.filter((entry) => !blockedSet.has(entry.id)) : cached;
                setOtherProfiles(filteredCached);
              } else {
                setOtherProfiles([]);
              }
            } else {
              setOtherProfiles([]);
            }
          } catch (cacheError) {
            console.warn('Не удалось прочитать кеш анкет других пользователей', cacheError);
            setOtherProfiles([]);
          }
          setOtherHasMore(false);
          otherPagingHasMoreRef.current = false;
          return;
        }

        if (!oppositeGender) {
          setOtherProfiles([]);
          setOtherHasMore(false);
          otherPagingHasMoreRef.current = false;
          return;
        }

        const offset = reset ? 0 : otherPagingOffsetRef.current;
        const end = offset + OTHER_PROFILES_PAGE_SIZE - 1;

        const runQuery = async (includeUpdatedAt: boolean) => {
          let query = supabase
            .from('profiles')
            .select(includeUpdatedAt ? 'id, data, last_seen_at, updated_at' : 'id, data, last_seen_at')
            .neq('id', userId ?? '')
            .eq('data->>gender', oppositeGender)
            .order('last_seen_at', { ascending: false, nullsFirst: false });

          if (includeUpdatedAt) {
            query = query.order('updated_at', { ascending: false, nullsFirst: false });
          }

          query = query.order('id', { ascending: false }).range(offset, end);
          return await query;
        };

        let { data, error } = await runQuery(true);
        if (error && typeof (error as { message?: unknown }).message === 'string') {
          const msg = String((error as { message?: unknown }).message);
          if (/updated_at/i.test(msg) && /does not exist/i.test(msg)) {
            ({ data, error } = await runQuery(false));
          }
        }

        if (error) {
          console.warn('Failed to load other profiles:', error);
          return;
        }

        const rows = Array.isArray(data) ? data : [];
        if (seq !== otherPagingSeqRef.current) return;
        const rawCount = rows.length;
        const hasMore = rawCount === OTHER_PROFILES_PAGE_SIZE;
        otherPagingOffsetRef.current = offset + rawCount;
        setOtherHasMore(hasMore);
        otherPagingHasMoreRef.current = hasMore;

        const existingIds = new Set(otherProfilesRef.current.map((p) => p.id));
        const blockedSet = blockedIdsRef.current;
        const mapped = rows
          .map((entry) => {
            if (!isRecord(entry) || typeof entry.id !== 'string') return null;
            if (existingIds.has(entry.id)) return null;
            if (blockedSet.size && blockedSet.has(entry.id)) return null;
            const snapshot = isRecord(entry.data) ? (entry.data as Record<string, unknown>) : {};
            const lastSeenRaw = entry['last_seen_at'];
            const lastSeenAt = typeof lastSeenRaw === 'string' ? lastSeenRaw : null;
            const personName = typeof snapshot.personName === 'string' ? snapshot.personName : '';
            const lastName = typeof snapshot.lastName === 'string' ? snapshot.lastName : '';
            const selectedCity = typeof snapshot.selectedCity === 'string' ? snapshot.selectedCity : '';
            const cityNameRuRaw = typeof snapshot.cityNameRu === 'string' ? snapshot.cityNameRu : '';
            const cityNameRu = cityNameRuRaw || (selectedCity ? latinToRuName(selectedCity) : '');
            const residenceCountry = typeof snapshot.residenceCountry === 'string' ? snapshot.residenceCountry : '';
            const residenceCityName =
              typeof snapshot.residenceCityName === 'string'
                ? snapshot.residenceCityName
                : typeof snapshot.residenceCity === 'string'
                  ? snapshot.residenceCity
                  : '';
            const mainPhoto = typeof snapshot.mainPhoto === 'string' ? snapshot.mainPhoto : null;
            const smallPhotos = normalizeSmallPhotosField(snapshot.smallPhotos);
            const birth = typeof snapshot.birth === 'string' ? snapshot.birth : null;
            const ascSignFromProfile = typeof snapshot.ascSign === 'string' ? snapshot.ascSign : null;
            const gender = normalizeGender(snapshot.gender);
            const typeazh = typeof snapshot.typeazh === 'string' ? snapshot.typeazh : '';
            const familyStatus = typeof snapshot.familyStatus === 'string' ? snapshot.familyStatus : '';
            const about = typeof snapshot.about === 'string' ? snapshot.about : '';
            const interests = typeof snapshot.interests === 'string' ? snapshot.interests : '';
            const religion = typeof snapshot.religion === 'string' ? snapshot.religion : '';
            const career = typeof snapshot.career === 'string' ? snapshot.career : '';
            const profession = typeof snapshot.profession === 'string' ? snapshot.profession : '';
            const children = typeof snapshot.children === 'string' ? snapshot.children : '';
            return {
              id: entry.id,
              personName,
              lastName,
              selectedCity,
              cityNameRu,
              residenceCountry,
              residenceCityName,
              mainPhoto,
              smallPhotos,
              birth,
              ascSign: ascSignFromProfile,
              gender,
              typeazh,
              familyStatus,
              about,
              interests,
              religion,
              career,
              profession,
              children,
              chartScreenshot: null,
              chart: null,
              chartSignature: null,
              lastSeenAt,
            } as OtherProfilePreview;
          })
          .filter((item): item is OtherProfilePreview => Boolean(item));

        const withCharts = await Promise.all(
          mapped.map(async (entry) => {
            let chartScreenshot: string | null = null;
            let chartPayload: ChartPayload = null;
            let finalAscSign = entry.ascSign;
            try {
              const { data: chartRow, error: chartErr } = await supabase
                .from('charts')
                .select('chart, meta')
                .eq('user_id', entry.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
              if (chartErr && chartErr.code !== 'PGRST116') {
                console.warn('Failed to load chart for preview:', chartErr);
              }
              if (chartRow && isRecord(chartRow)) {
                const normalized = toChartRow(chartRow);
                chartPayload = normalized.chart ?? null;
                chartScreenshot = resolveScreenshotFromAny(normalized) ?? extractChartScreenshot(normalized);
                if (chartScreenshot && typeof chartScreenshot === 'string' && needsSupabaseResolution(chartScreenshot)) {
                  try {
                    const resolved = await resolveSupabaseScreenshotUrl(chartScreenshot);
                    if (resolved && typeof resolved === 'string' && !resolved.startsWith('supabase://')) {
                      chartScreenshot = resolved;
                    }
                    if (chartScreenshot?.startsWith('supabase://')) {
                      chartScreenshot = null;
                    }
                  } catch (resolveError) {
                    console.warn('Failed to resolve chart screenshot for preview', resolveError);
                    chartScreenshot = null;
                  }
                }

                if (!finalAscSign) {
                  finalAscSign = extractAscSignFromChart(normalized);
                }
              }
            } catch (chartError) {
              console.warn('Unexpected chart preview error:', chartError);
            }
            const chartSignature = computeChartSignature(chartPayload);
            return { ...entry, chartScreenshot, chart: chartPayload, ascSign: finalAscSign, chartSignature };
          }),
        );

        if (seq !== otherPagingSeqRef.current) return;

        const mergedBase = reset ? [] : otherProfilesRef.current;
        const combined = [...mergedBase, ...withCharts];
        const seen = new Set<string>();
        const unique: OtherProfilePreview[] = [];
        for (const entry of combined) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          unique.push(entry);
        }

        setOtherProfiles(unique);

        try {
          localStorage.setItem(
            OTHER_PROFILES_CACHE_KEY,
            JSON.stringify({ userId: userId ?? null, entries: unique.slice(0, OTHER_PROFILES_CACHE_MAX) }),
          );
        } catch (cacheSaveError) {
          console.warn('Не удалось сохранить кеш анкет других пользователей', cacheSaveError);
        }
      } catch (error) {
        console.warn('Unexpected error while loading other profiles:', error);
      } finally {
        if (seq === otherPagingSeqRef.current) {
          otherPagingInFlightRef.current = false;
          setOtherLoading(false);
          setOtherLoadingMore(false);
        }
      }
    },
    [isOnline, oppositeGender, userId],
  );

  useEffect(() => {
    void loadOtherProfilesPage({ reset: true });
  }, [loadOtherProfilesPage]);

  const handleLoadMoreOtherProfiles = useCallback(() => {
    void loadOtherProfilesPage({ reset: false });
  }, [loadOtherProfilesPage]);

  useEffect(() => {
    if (!isOnline) return;
    if (!otherHasMore) return;
    const el = otherLoadMoreSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          handleLoadMoreOtherProfiles();
        }
      },
      { root: null, rootMargin: '400px 0px', threshold: 0.01 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleLoadMoreOtherProfiles, isOnline, otherHasMore]);

  useEffect(() => {
    if (!blockedKeys.length) return;
    const blocked = new Set(blockedKeys);
    setOtherProfiles((prev) => prev.filter((entry) => !blocked.has(entry.id)));
  }, [blockedKeys]);
  useEffect(() => {
    updateCompatibilityMap((prev) => {
      const next: Record<string, CompatibilityPreview> = {};
      for (const entry of otherProfiles) {
        const signature = entry.chartSignature ?? computeChartSignature(entry.chart);
        const existing = prev[entry.id];
        if (existing && existing.chartSignature === signature) {
          next[entry.id] = existing;
        }
      }
      return next;
    });
  }, [otherProfiles, updateCompatibilityMap]);

  useEffect(() => {
    if (!selectedOtherProfileId) return;
    const stillExists = otherProfiles.some((entry) => entry.id === selectedOtherProfileId);
    if (!stillExists) {
      setSelectedOtherProfileId(null);
    }
  }, [otherProfiles, selectedOtherProfileId]);
  useEffect(() => {
    if (!profile) return;
    const baseChartPayload = extractChartPayload(chart);
    if (!baseChartPayload) return;
    if (!otherProfiles.length) return;
    let cancelled = false;
    const baseKujaList = analyzeKujaDosha(baseChartPayload);
    const baseHasKuja = baseKujaList.length > 0;
    const process = async () => {
      for (const entry of otherProfiles) {
        if (cancelled) return;
        const entrySignature = entry.chartSignature ?? computeChartSignature(entry.chart);
        const existing = compatibilityRef.current[entry.id];
        if (existing && existing.status === 'ready' && existing.chartSignature === entrySignature) {
          continue;
        }
        if (!entry.chart) {
          updateCompatibilityMap((prev) => ({
            ...prev,
            [entry.id]: {
              status: 'ready',
              percent: null,
              basePercent: null,
              kujaPenalty: null,
              hasCurrentKuja: baseHasKuja,
              hasOtherKuja: false,
              error: 'Моя карта не найдена.',
              chartSignature: entrySignature,
            },
          }));
          continue;
        }
        updateCompatibilityMap((prev) => {
          const current = prev[entry.id];
          if (current && current.status === 'ready' && current.chartSignature === entrySignature) return prev;
          return {
            ...prev,
            [entry.id]: {
              status: 'loading',
              percent: null,
              basePercent: null,
              kujaPenalty: null,
              hasCurrentKuja: baseHasKuja,
              hasOtherKuja: false,
              chartSignature: entrySignature,
            },
          };
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          const otherKujaList = analyzeKujaDosha(entry.chart);
          
          // Calculate compatibility from current user's perspective (matching left block on Sinastry)
          const currentUserResult = computeDirectionalSynastry({
            selfChart: baseChartPayload,
            partnerChart: entry.chart,
            selfBirth: profile.birth,
            partnerBirth: entry.birth ?? undefined,
            selfGender: profile.gender,
            partnerGender: entry.gender ?? undefined,
          });
          
          const basePercent = currentUserResult.basePercent;
          const finalPercent = currentUserResult.finalPercent;
          const kujaPenalty = currentUserResult.kujaPenalty;
          const sunMoonBonus = currentUserResult.sunMoonBonus;
          if (!cancelled) {
            updateCompatibilityMap((prev) => ({
              ...prev,
              [entry.id]: {
                status: 'ready',
                percent: finalPercent,
                basePercent: basePercent,
                kujaPenalty,
                sunMoonBonus,
                hasCurrentKuja: baseHasKuja,
                hasOtherKuja: otherKujaList.length > 0,
                chartSignature: entrySignature,
              },
            }));
          }
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : 'Не удалось вычислить совместимость.';
            updateCompatibilityMap((prev) => ({
              ...prev,
              [entry.id]: {
                status: 'error',
                percent: null,
                basePercent: null,
                kujaPenalty: null,
                hasCurrentKuja: baseHasKuja,
                hasOtherKuja: false,
                error: message,
                chartSignature: entrySignature,
              },
            }));
          }
        }
      }
    };
    void process();
    return () => {
      cancelled = true;
    };
  }, [profile, chart, otherProfiles, updateCompatibilityMap]);
  if (loadingError) {
    return (
      <div className="p-8 text-center text-red-400">
        <div>{loadingError}</div>
        <div className="mt-2 text-sm text-white/70">
          Если проект Supabase поставлен на паузу, возобновите его в консоли Supabase и обновите страницу.
        </div>
        {isProfileLoadError ? (
          <div className="mt-1 text-xs text-white/50">Автоповтор через 10 секунд.</div>
        ) : null}
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-4 py-2 text-sm`}
            onClick={() => navigate("/app", { replace: true })}
          >
            Назад
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm text-white/80 hover:bg-white/15"
            onClick={() => window.location.reload()}
          >
            Обновить
          </button>
        </div>
      </div>
    );
  }
  if (!profile) {
    return <div className="p-8">Загрузка данных пользователя...</div>;
  }
  const rawScreenshotUrl = chart ? extractChartScreenshot(chart) : null;
  const screenshotUrl = rawScreenshotUrl && rawScreenshotUrl.startsWith('supabase://') ? null : rawScreenshotUrl;
  const ownChartPayload = extractChartPayload(chart);
  const isOwnProfile = Boolean(currentUserId && userId && currentUserId === userId);
  
  // Resolve ascendant sign with fallback logic (like in Questionnaire)
  const ascSign = (() => {
    // 1. Check profile.ascSign
    const profileAsc = typeof profile.ascSign === 'string' ? profile.ascSign.trim() : '';
    if (profileAsc) return profileAsc;
    
    // 2. Extract from chart data
    const chartAsc = extractAscSignFromChart(chart);
    if (chartAsc) return chartAsc;
    
    // 3. Try local saved chart fallback (only for own profile)
    if (isOwnProfile) {
      try {
        const savedPayload = readSavedChartSource(currentUserId ?? undefined);
        if (savedPayload) {
          const localChart = isRecord(savedPayload['chart']) ? savedPayload['chart'] : null;
          if (localChart) {
            const localAsc = extractAscSignFromChart(toChartRow({ chart: localChart }));
            if (localAsc) return localAsc;
          }
          const localProfile = isRecord(savedPayload['profile']) ? savedPayload['profile'] : null;
          if (localProfile && typeof localProfile.ascSign === 'string') {
            return localProfile.ascSign;
          }
        }
      } catch (err) {
        console.warn('Failed to read ascSign from saved chart cache', err);
      }
    }
    
    return null;
  })();

  const age = calculateAge(profile.birth);
  const profileFullName = `${profile.personName ?? ''} ${profile.lastName ?? ''}`.trim();
  const profileTitle = age !== null ? `${profileFullName}, ${formatAgeRu(age)}` : profileFullName;
  const genderText = profile.gender === 'male' ? 'мужской' : profile.gender === 'female' ? 'женский' : '—';
  const profileCityLabel = getCityLabel(profile.cityNameRu, profile.selectedCity);
  const profileResidenceLabel = formatResidenceLabel(profile.residenceCityName, profile.residenceCountry);
  const currentPhoto = photoUrls[photoIndex] ?? null;
  const canPrevPhoto = photoIndex > 0;
  const canNextPhoto = photoIndex < photoUrls.length - 1;
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-[1450px] mx-auto px-0 pb-8 pt-3">
      {!isOnline && (
        <div className="mb-6 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-200">
          Нет подключения к сети. Показаны закэшированные данные профиля и анкет.
        </div>
      )}
      <header className="mb-8">
        <div className="flex justify-between items-center mb-2">
          <h1 className="text-3xl font-bold">{profileTitle || 'Имя не указано'}</h1>
          <div className="flex flex-wrap gap-2 items-start">
            <button
              onClick={(event) => {
                requestNewChartReset('profile');
                event.currentTarget.blur();
              }}
              className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            >
              Новая карта
            </button>
            <button
              onClick={() => navigate(fromFileRef.current ? '/chart?fromFile=1' : '/chart')}
              className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            >
              Моя карта
            </button>
            <button
              onClick={() => navigate(fromFileRef.current ? '/questionnaire?fromFile=1' : '/questionnaire')}
              className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            >
              Анкета
            </button>
            <button
              disabled
              className={`${BUTTON_PRIMARY} px-3 py-1.5 text-sm cursor-default`}
            >
              Профиль
            </button>
            <button
              onClick={() => navigate(fromFileRef.current ? '/sinastry?fromFile=1' : '/sinastry')}
              className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            >
              Синастрия
            </button>
            <button
              onClick={() => navigate(fromFileRef.current ? '/chart/additional?fromFile=1' : '/chart/additional')}
              className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            >
              Модули Джйотиш
            </button>
          </div>
        </div>
        {identityEmail && isOwnProfile ? (
          <div className="text-sm text-white/60 mb-2">{'\u0412\u0430\u0448 \u043b\u043e\u0433\u0438\u043d: '}{identityEmail}</div>
        ) : null}
        <div className="text-base text-gray-600">
          Локальное время: {profile.birth?.replace('T', '; T') || '—'}<br />
          Восходящий знак: {ascSign || '—'}<br />
          Пол: {genderText}<br />
          Место рождения: {profileCityLabel || '—'}<br />
          Место жительства: {profileResidenceLabel || '—'}
        </div>
      </header>
      <div className="user-profile-layout">
        <div className="user-profile-left space-y-3">
          {/* Photos */}
          <div className="user-profile-card">
            <div className="mx-auto w-full max-w-[360px]">
              <div className="relative overflow-hidden rounded-lg border border-blue-300 p-1">
                {currentPhoto ? (
                  <img src={currentPhoto} alt="Фото" className="block w-full h-[286px] object-contain rounded-lg bg-transparent" />
                ) : (
                  <div className="bg-transparent border border-dashed border-blue-300 rounded-lg w-full h-[286px] flex items-center justify-center text-sm text-blue-500">
                    Нет фото
                  </div>
                )}
                {canPrevPhoto ? (
                  <button
                    type="button"
                    aria-label="Предыдущее фото"
                    onClick={() => setPhotoIndex((i) => Math.max(0, i - 1))}
                    className="absolute top-1/2 -translate-y-1/2 h-9 w-9 rounded-full border border-black/30 bg-black/50 text-white flex items-center justify-center z-10"
                    style={{ left: 2, right: "auto" }}
                  >
                    ‹
                  </button>
                ) : null}
                {canNextPhoto ? (
                  <button
                    type="button"
                    aria-label="Следующее фото"
                    onClick={() => setPhotoIndex((i) => Math.min(photoUrls.length - 1, i + 1))}
                    className="absolute top-1/2 -translate-y-1/2 h-9 w-9 rounded-full border border-black/30 bg-black/50 text-white flex items-center justify-center z-10"
                    style={{ right: 2, left: "auto" }}
                  >
                    ›
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          {/* Chart screenshot */}
          <div className="user-profile-card flex flex-col items-start">
            <div className="bg-white border border-blue-200 rounded-lg p-2 mb-2 w-full overflow-hidden">
              {screenshotUrl ? (
                <AutoAspectImage
                  src={screenshotUrl}
                  alt="Скриншот карты"
                  wrapperClassName="mx-auto w-full max-w-[360px]"
                  imgClassName="object-contain"
                />
              ) : (
                <div className="mx-auto w-full max-w-[360px] aspect-[3/2] flex items-center justify-center text-gray-400">
                  Нет скриншота карты
                </div>
              )}
            </div>
          </div>
          {/* Profile info after chart */}
          <div className="user-profile-card">
            <div className="grid grid-cols-2 gap-4 pb-[10px]">
              <div>
                <h3 className="text-lg font-semibold leading-tight mb-1">Рост</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.typeazh || 'Не указано'}</div>
              </div>
              <div>
                <h3 className="text-lg font-semibold leading-tight mb-1">Семейное положение</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.familyStatus || 'Не указано'}</div>
              </div>
              <div className="col-span-2">
                <h3 className="text-lg font-semibold leading-tight mb-1">О себе</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.about || 'Не указано'}</div>
              </div>
              <div>
                <h3 className="text-lg font-semibold leading-tight mb-1">Интересы</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.interests || 'Не указано'}</div>
              </div>
              <div>
                <h3 className="text-lg font-semibold leading-tight mb-1">Религия</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.religion || 'Не указано'}</div>
              </div>
              <div className="col-span-2">
                <h3 className="text-lg font-semibold leading-tight mb-1">Образование</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.career || 'Не указано'}</div>
              </div>
              <div>
                <h3 className="text-lg font-semibold leading-tight mb-1">Дети</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.children || 'Не указано'}</div>
              </div>
              <div>
                <h3 className="text-lg font-semibold leading-tight mb-1">Профессия</h3>
                <div className="text-base leading-snug whitespace-pre-line">{profile.profession || 'Не указано'}</div>
              </div>
            </div>
          </div>
        </div>
        <aside className="user-profile-sidebar">
          <div className="user-profile-scroll">
	            <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4 flex flex-col h-full">
	              <h2 className="text-lg font-semibold text-white mb-3">Анкеты других пользователей</h2>
	              <div className="flex-1 pr-1">
	                {selectedOtherProfile ? (
	                  (() => {
	                    const entry = selectedOtherProfile;
	                    const fullName =
	                      (entry.personName || 'Имя не указано') + (entry.lastName ? ` ${entry.lastName}` : '');
	                    const age = calculateAge(entry.birth);
	                    const ageLabel = typeof age === 'number' ? formatAgeRu(age) : null;
	                    const genderLabel =
	                      entry.gender === 'male' ? 'мужской' : entry.gender === 'female' ? 'женский' : '—';
	                    const birthPlaceLabel = getCityLabel(entry.cityNameRu, entry.selectedCity);
	                    const residenceLabel = formatResidenceLabel(entry.residenceCityName, entry.residenceCountry);

	                    const photoUrls = [
	                      typeof entry.mainPhoto === 'string' ? entry.mainPhoto : null,
	                      ...(Array.isArray(entry.smallPhotos) ? entry.smallPhotos : []),
	                    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

	                    const safeIndex = Math.min(
	                      Math.max(0, otherProfilePhotoIndex),
	                      Math.max(0, photoUrls.length - 1),
	                    );
	                    const currentPhoto = photoUrls.length ? photoUrls[safeIndex] : null;
	                    const canPrevPhoto = safeIndex > 0;
	                    const canNextPhoto = safeIndex < photoUrls.length - 1;

	                    const chatDisabled =
	                      !currentUserId ||
	                      !selfGender ||
	                      !entry.gender ||
	                      entry.gender === selfGender;

	                    return (
	                      <div className="space-y-3">
	                        <div className="flex items-center justify-between gap-2">
	                          <button
	                            type="button"
	                            onClick={() => setSelectedOtherProfileId(null)}
	                            className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
	                          >
	                            Назад
	                          </button>
	                          <button
	                            type="button"
	                            onClick={() => handleOpenChat(entry)}
	                            className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
	                            disabled={chatDisabled}
	                            title={
	                              !currentUserId
	                                ? 'Требуется вход в учётную запись'
	                                : !selfGender
	                                  ? 'Укажите свой пол, чтобы открыть чат'
	                                  : !entry.gender || entry.gender === selfGender
	                                    ? 'Чат доступен только с противоположным полом'
	                                    : partnerActionsLocked
	                                      ? 'Для чата нужна активная лицензия'
	                                      : 'Открыть окно чата'
	                            }
	                          >
	                            Чат
	                          </button>
	                        </div>

	                        <div className="text-base font-bold text-white">
	                          {fullName}
	                          {ageLabel ? `, ${ageLabel}` : ''}
	                        </div>

	                        <div className="text-xs text-white/80 space-y-1">
	                          <div>
	                            <span className="text-white font-semibold">Восходящий знак:</span> {entry.ascSign || '—'}
	                          </div>
	                          <div>
	                            <span className="text-white font-semibold">Пол:</span> {genderLabel}
	                          </div>
	                          <div>
	                            <span className="text-white font-semibold">Место рождения:</span> {birthPlaceLabel || '—'}
	                          </div>
	                          <div>
	                            <span className="text-white font-semibold">Место жительства:</span> {residenceLabel || '—'}
	                          </div>
	                        </div>

	                        <div className="relative overflow-hidden rounded-lg border border-blue-300 p-1 bg-white/5">
	                          {currentPhoto ? (
	                            <img
	                              src={currentPhoto}
	                              alt="Фото"
	                              className="block w-full h-[286px] object-contain rounded-lg bg-transparent"
	                            />
	                          ) : (
	                            <div className="bg-transparent border border-dashed border-blue-300 rounded-lg w-full h-[286px] flex items-center justify-center text-sm text-blue-500">
	                              Нет фото
	                            </div>
	                          )}
	                          {canPrevPhoto ? (
	                            <button
	                              type="button"
	                              aria-label="Предыдущее фото"
	                              onClick={() => setOtherProfilePhotoIndex((i) => Math.max(0, i - 1))}
	                              className="absolute top-1/2 -translate-y-1/2 h-9 w-9 rounded-full border border-black/30 bg-black/50 text-white flex items-center justify-center z-10"
	                              style={{ left: 2, right: 'auto' }}
	                            >
	                              ‹
	                            </button>
	                          ) : null}
	                          {canNextPhoto ? (
	                            <button
	                              type="button"
	                              aria-label="Следующее фото"
	                              onClick={() =>
	                                setOtherProfilePhotoIndex((i) => Math.min(Math.max(0, photoUrls.length - 1), i + 1))
	                              }
	                              className="absolute top-1/2 -translate-y-1/2 h-9 w-9 rounded-full border border-black/30 bg-black/50 text-white flex items-center justify-center z-10"
	                              style={{ right: 2, left: 'auto' }}
	                            >
	                              ›
	                            </button>
	                          ) : null}
	                        </div>

	                        <div className="relative overflow-hidden rounded-lg border border-blue-300 p-1 bg-white/5 w-full">
	                          {entry.chartScreenshot ? (
	                            <AutoAspectImage
	                              src={entry.chartScreenshot}
	                              alt="Скриншот карты"
	                              wrapperClassName="mx-auto w-full max-w-[360px]"
	                              imgClassName="object-contain"
	                            />
	                          ) : (
	                            <div className="mx-auto w-full max-w-[360px] aspect-[3/2] flex items-center justify-center text-gray-400">
	                              Нет скриншота карты
	                            </div>
	                          )}
	                        </div>

	                        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
	                          <div className="grid grid-cols-2 gap-4 pb-[10px]">
	                            <div>
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Рост</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.typeazh || 'Не указано'}
	                              </div>
	                            </div>
	                            <div>
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Семейное положение</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.familyStatus || 'Не указано'}
	                              </div>
	                            </div>
	                            <div className="col-span-2">
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">О себе</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.about || 'Не указано'}
	                              </div>
	                            </div>
	                            <div>
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Интересы</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.interests || 'Не указано'}
	                              </div>
	                            </div>
	                            <div>
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Религия</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.religion || 'Не указано'}
	                              </div>
	                            </div>
	                            <div className="col-span-2">
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Образование</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.career || 'Не указано'}
	                              </div>
	                            </div>
	                            <div>
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Профессия</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.profession || 'Не указано'}
	                              </div>
	                            </div>
	                            <div>
	                              <h3 className="text-sm font-semibold leading-tight mb-1 text-white">Дети</h3>
	                              <div className="text-sm leading-snug whitespace-pre-line text-white/80">
	                                {entry.children || 'Не указано'}
	                              </div>
	                            </div>
	                          </div>
	                        </div>
	                      </div>
	                    );
	                  })()
	                ) : otherLoading ? (
                  <div className="text-sm text-white/70">Идёт загрузка анкет...</div>
                ) : !selfGender ? (
                  <div className="text-sm text-white/80">
                    Укажите пол в анкете, чтобы видеть подходящие профили и открывать чат.
                  </div>
                ) : visibleOtherProfiles.length === 0 ? (
                  <div className="text-sm text-white/70">
                    {isOnline ? 'Анкеты пока не найдены.' : 'Нет подключения: список анкет недоступен.'}
                    {isOnline && otherHasMore && (
                      <div className="mt-3 flex flex-col items-center gap-2">
                        {otherLoadingMore && <div className="text-xs text-white/60">Загружаем ещё...</div>}
                        <button
                          type="button"
                          onClick={handleLoadMoreOtherProfiles}
                          disabled={otherLoadingMore || otherLoading}
                          className={`${BUTTON_SECONDARY} w-full px-3 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed`}
                        >
                          Показать ещё
                        </button>
                        <div ref={otherLoadMoreSentinelRef} style={{ height: 1 }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <ul className="space-y-3 list-none p-0 m-0" style={{ margin: 0, padding: 0 }}>
                      {visibleOtherProfiles.map((entry) => {
                      const fullName = (entry.personName || 'Имя не указано') + (entry.lastName ? ` ${entry.lastName}` : '');
                      const age = calculateAge(entry.birth);
                      const ageLabel = typeof age === 'number' ? formatAgeRu(age) : null;
                      const genderLabel = entry.gender === 'male' ? 'мужской' : entry.gender === 'female' ? 'женский' : '-';
                      const compat = compatibilityMap[entry.id];
                      const unreadCount = unreadCounts[entry.id] ?? 0;
                      const hasUnread = unreadCount > 0;
                      const chatLabel = hasUnread ? `Чат (${unreadCount})` : 'Чат';
                      const birthPlaceLabel = getCityLabel(entry.cityNameRu, entry.selectedCity);
                      const residenceLabel = formatResidenceLabel(entry.residenceCityName, entry.residenceCountry);
                      const offlineCached = !isOnline;
                      const compatibilityLabel = (() => {
                        if (!ownChartPayload) return 'нет вашей карты';
                        if (!entry.chart) return 'нет карты у пользователя';
                        if (!compat) return 'считаем...';
                        if (compat.status === 'loading') return 'считаем...';
                        if (compat.status === 'error') return compat.error || 'ошибка вычисления';
                        if (compat.percent !== null) {
                          const penaltyNote = compat.kujaPenalty
                            ? ` (база ${compat.basePercent ?? '—'}%, штраф ${compat.kujaPenalty}%)`
                            : '';
                          const bonusNote = compat.sunMoonBonus && compat.sunMoonBonus > 0
                            ? ` (бонус +${compat.sunMoonBonus}%)`
                            : '';
                          return `${compat.percent}%${penaltyNote}${bonusNote}`;
                        }
                        return compat.error || '—';
                      })();
                      const kujaLabel = (() => {
                        if (!ownChartPayload || !entry.chart) return 'нет данных';
                        if (!compat) return 'считаем...';
                        if (compat.status === 'loading') return 'считаем...';
                        if (compat.status === 'error') return compat.error ? 'нет данных' : '—';
                        
                        // Show if CURRENT user (owner of this profile) has Kuja, not the candidate
                        if (compat.hasCurrentKuja) {
                          return compat.kujaPenalty ? `ваша даёт штраф ${compat.kujaPenalty}%` : 'ваша есть';
                        }
                        
                        // If current user doesn't have Kuja, show partner's status
                        return compat.hasOtherKuja ? `у партнёра есть` : 'нет';
                      })();
                      const typeazhPreview = entry.typeazh
                        ? entry.typeazh.length > 160
                          ? `${entry.typeazh.slice(0, 157).trim()}…`
                          : entry.typeazh
                        : 'Не указано';
                      const statusBadge = describeOnlineStatus(entry.lastSeenAt, entry.gender);
                      return (
                        <li
                          key={entry.id}
                          className="rounded-lg border border-white/10 bg-white/5 p-3 hover:border-blue-400 transition-colors flex flex-col gap-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-3 flex-wrap">
                                <div className="text-sm font-bold text-white truncate max-w-[220px] mr-1" style={{ fontWeight: 700 }}>
                                  {fullName}{ageLabel ? `, ${ageLabel}` : ''}
                                </div>
                                <span
                                  className={`inline-flex shrink-0 items-center rounded-full border px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide mt-0.5 ${statusBadge.badgeClass}`}
                                  title={statusBadge.title}
                                  style={{ ...statusBadge.style, marginLeft: '10px' }}
                                >
                                  {statusBadge.label}
                                </span>
                              </div>
                              {ageLabel ? null : <div className="text-xs text-white/60">Возраст не указан</div>}
                            </div>
	                            <div className="flex items-center gap-2">
	                              <button
	                                type="button"
	                                onClick={() => {
	                                  if (partnerActionsLocked) {
	                                    requestPartnerActionsAccess();
	                                    return;
	                                  }
	                                  setSelectedOtherProfileId(entry.id);
	                                }}
	                                className="px-3 py-1 border border-black text-xs font-semibold whitespace-nowrap transition-colors bg-[#f5d6ab] hover:bg-[#eed0a3]"
	                                title={partnerActionsLocked ? 'Чтобы открыть анкету пользователя, нужна лицензия' : 'Открыть анкету пользователя'}
	                              >
	                                Анкета
	                              </button>
	                              <button
	                                type="button"
	                                onClick={() => handleOpenChat(entry)}
	                                className={`px-3 py-1 border border-black text-xs font-semibold whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
	                                  hasUnread ? 'bg-[#f0c0c0]' : 'bg-[#f5d6ab]'
	                                }`}
	                                disabled={!currentUserId || !selfGender || !entry.gender || entry.gender === selfGender}
	                                title={
	                                  !currentUserId
	                                    ? 'Требуется вход в учётную запись'
	                                    : !selfGender
	                                      ? 'Укажите свой пол, чтобы открыть чат'
	                                      : !entry.gender || entry.gender === selfGender
	                                        ? 'Чат доступен только с противоположным полом'
	                                        : partnerActionsLocked
	                                          ? 'Для чата нужна активная лицензия'
	                                          : 'Открыть окно чата'
	                                }
	                              >
	                                {chatLabel}
	                              </button>
	                            </div>
	                          </div>
                          <div className="flex flex-row flex-wrap gap-3 md:gap-4 md:flex-nowrap md:items-stretch">
                            <div className="w-[100px] h-[140px] md:h-auto bg-white/10 border border-white/20 rounded overflow-hidden flex-shrink-0">
                              {entry.mainPhoto ? (
                                <img src={entry.mainPhoto} alt={entry.personName || 'Главное фото'} className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-xs text-white/60 text-center px-1">Нет фото</div>
                              )}
                            </div>
                            <div className="w-[200px] h-[140px] md:h-auto bg-white/10 border border-white/20 rounded overflow-hidden flex-shrink-0">
                              {entry.chartScreenshot ? (
                                <img src={entry.chartScreenshot} alt="Скриншот карты" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-xs text-white/60 text-center px-1">
                                  Нет скриншота карты
                                </div>
                              )}
                            </div>
                            <div className="flex-1 bg-white/5 border border-white/10 rounded p-2 text-xs text-white/80 space-y-1">
                              <div><span className="text-white font-semibold">Пол:</span> {genderLabel}</div>
                              <div><span className="text-white font-semibold">Место рождения:</span> {birthPlaceLabel || '—'}</div>
                              <div><span className="text-white font-semibold">Место жительства:</span> {residenceLabel || '—'}</div>
                              <div><span className="text-white font-semibold">Восходящий знак:</span> {entry.ascSign || '—'}</div>
                              <div><span className="text-white font-semibold">Совместимость:</span> {compatibilityLabel}</div>
                              <div><span className="text-white font-semibold">Куджа-доша:</span> {kujaLabel}</div>
                              {offlineCached && (
                                <div className="text-white/50">Данные из локального кеша</div>
                              )}
                              <div className="pt-1"><span className="text-white font-semibold">Рост:</span> <span className="text-white/70">{typeazhPreview || 'Не указано'}</span></div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                    </ul>
                    {isOnline && (
                      <div className="mt-3 flex flex-col items-center gap-2">
                        {otherLoadingMore && <div className="text-xs text-white/60">Загружаем ещё...</div>}
                        {otherHasMore ? (
                          <button
                            type="button"
                            onClick={handleLoadMoreOtherProfiles}
                            disabled={otherLoadingMore || otherLoading}
                            className={`${BUTTON_SECONDARY} w-full px-3 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed`}
                          >
                            Показать ещё
                          </button>
                        ) : (
                          <div className="text-xs text-white/50">Больше анкет нет.</div>
                        )}
                      </div>
                    )}
                    {isOnline && otherHasMore && <div ref={otherLoadMoreSentinelRef} style={{ height: 1 }} />}
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
    </div>
  );
};
export default UserProfilePage;

