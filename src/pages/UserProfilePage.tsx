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
import { needsSupabaseResolution, resolveSupabaseScreenshotUrl } from '../utils/screenshotUrl';
import { useBlocklistStore } from '../store/blocklist';
import { PROFILE_SNAPSHOT_STORAGE_KEY as STORAGE_KEY } from '../constants/storageKeys';
import { requestNewChartReset } from '../utils/newChartRequest';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../constants/buttonPalette';
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
  career: string;
  children: string;
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
  birth: string | null;
  ascSign: string | null;
  chartScreenshot: string | null;
  gender: "male" | "female" | null;
  typeazh: string;
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
    if (typeof chartValue.screenshotUrl === 'string') {
      return chartValue.screenshotUrl;
    }
    if (typeof chartValue.screenshotStoragePointer === 'string') {
      return chartValue.screenshotStoragePointer;
    }
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

const describeOnlineStatus = (lastSeenAt: string | null): OnlineStatusDescriptor => {
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
  return {
    label: `был ${formatAgoLabel(diff)} назад`,
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
    career: '',
    children: '',
  };
  const seen = new Set<object>();
  const assignStringField = (key: keyof UserProfile, value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    const current = result[key];
    const currentString = typeof current === 'string' ? current : '';
    if (trimmed) {
      (result as Record<string, unknown>)[key] = value;
    } else if (!currentString.trim()) {
      (result as Record<string, unknown>)[key] = value;
    }
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
    assignStringField('career', record.career);
    assignStringField('children', record.children);
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
    result.career,
    result.children,
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
  const birth = typeof value.birth === 'string' ? value.birth : null;
  const ascSign = typeof value.ascSign === 'string' ? value.ascSign : null;
  const chartScreenshot = typeof value.chartScreenshot === 'string' ? value.chartScreenshot : null;
  const gender = normalizeGender(value.gender);
  const typeazh = typeof value.typeazh === 'string' ? value.typeazh : '';
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
    birth,
    ascSign,
    chartScreenshot,
    gender,
    typeazh,
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
const UserProfilePage: React.FC = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [chart, setChart] = useState<ChartRow | null>(null);
  const [identityEmail, setIdentityEmail] = useState<string | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<ElectronLicenseStatus | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [otherProfiles, setOtherProfiles] = useState<OtherProfilePreview[]>([]);
  const [otherLoading, setOtherLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
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
  const selfGender = useMemo(() => normalizeGender(profile?.gender), [profile?.gender]);
  const visibleOtherProfiles = useMemo(() => {
    const blockedSet = blockedKeys.length ? new Set(blockedKeys) : null;
    const base = blockedSet ? otherProfiles.filter((entry) => !blockedSet.has(entry.id)) : otherProfiles;
    if (!selfGender) return [];
    return base.filter((entry) => entry.gender && entry.gender !== selfGender);
  }, [blockedKeys, otherProfiles, selfGender]);
  const requestPurchaseDialog = useCallback(() => {
    try {
      const api = typeof window !== 'undefined' ? window.electronAPI?.license : undefined;
      if (api?.purchase) {
        void api.purchase();
      } else if (api?.requestPrompt) {
        void api.requestPrompt();
      }
    } catch (error) {
      console.warn('Не удалось открыть окно покупки лицензии', error);
    }
  }, []);
  const partnerSearchAllowed = useMemo(() => {
    if (!licenseStatus) return true;
    if (licenseStatus.licensed || licenseStatus.allowed) return true;
    const trialDays = licenseStatus.trial?.daysLeft;
    return typeof trialDays === 'number' ? trialDays > 0 : true;
  }, [licenseStatus]);
  const partnerSearchLocked = !partnerSearchAllowed;
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
      const seenSenders = new Set<string>();
      const clearedMap = clearedUnreadRef.current;
      for (const row of (data ?? []) as Array<{ sender_id: string | null; created_at: string | null }>) {
        if (typeof row.sender_id !== 'string') continue;
        seenSenders.add(row.sender_id);
        const createdAt = parseTimestamp(row.created_at);
        const clearedAt = clearedMap[row.sender_id];
        if (clearedAt && createdAt > 0 && createdAt <= clearedAt) {
          continue;
        }
        next[row.sender_id] = (next[row.sender_id] ?? 0) + 1;
      }
      if (currentUserId) {
        const existing = clearedUnreadRef.current;
        let mutated = false;
        const nextCleared: Record<string, number> = {};
        for (const [key, value] of Object.entries(existing)) {
          if (seenSenders.has(key)) {
            nextCleared[key] = value;
          } else {
            mutated = true;
          }
        }
        if (mutated) {
          clearedUnreadRef.current = nextCleared;
          writeClearedUnreadToStorage(currentUserId, nextCleared);
        }
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
    if (!currentUserId) return;
    const snapshot = chartCacheRef.current;
    if (!snapshot || snapshot.ownerId !== currentUserId) return;
    if (snapshot.profile) {
      const normalized = mergeProfileSnapshots(snapshot.profile, null);
      if (normalized) {
        setProfile((prev) => {
          if (!prev) return sanitizeOwnProfile(normalized);
          const prevFp = personFingerprint(prev);
          const nextFp = personFingerprint(normalized);
          if (!prevFp || prevFp === nextFp) {
            const merged = mergeProfileSnapshots(prev, normalized) ?? normalized;
            return sanitizeOwnProfile(merged);
          }
          return prev;
        });
      }
    }
    if (snapshot.chart) {
      setChart((prev) => {
        if (!prev) return toChartRow({ chart: snapshot.chart });
        const nextSignature = computeChartSignature(snapshot.chart as ChartPayload);
        const prevSignature = computeChartSignature(extractChartPayload(prev));
        if (!prevSignature || prevSignature !== nextSignature) {
          return toChartRow({ chart: snapshot.chart });
        }
        return prev;
      });
    }
  }, [currentUserId, cachedOwnerId, cachedProfileRecord, cachedChartRecord, sanitizeOwnProfile]);
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
    if (partnerSearchLocked) {
      setLoadingError('Чат заблокирован: нужен активный доступ поиска партнёров.');
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
  }, [blockedIds, encodeChatPayload, markMessagesRead, optimisticClearUnread, partnerSearchLocked, selfGender]);
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
    const raw = typeof chartValue.screenshotUrl === 'string' ? chartValue.screenshotUrl : pointer;
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
      if (!cancelled && resolved) {
        setChart((prev) => {
          if (!prev || !isRecord(prev.chart)) return prev;
          if (prev.chart?.screenshotResolved) return prev;
          return { ...prev, chart: { ...prev.chart, screenshotUrl: resolved, screenshotResolved: true } };
        });
      }
    })().catch((err) => {
      console.warn('Failed to resolve profile screenshot', err);
    });
    return () => {
      cancelled = true;
    };
  }, [chart]);
  useEffect(() => {
    const viewingOwnProfile = Boolean(currentUserId && userId && currentUserId === userId);
    const preferLocalSession = Boolean(fromFileRef.current && viewingOwnProfile);
    async function loadData() {
      if (!userId) return;
      const cacheSnapshot = chartCacheRef.current;
      
      try {
        setLoadingError(null);
        // Мгновенная загрузка из localStorage (если есть) — отображаем сразу
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
        const hasMatchingCache = Boolean(viewingOwnProfile && cacheSnapshot?.ownerId && cacheSnapshot.ownerId === currentUserId);
        let resolvedLocalScreenshot: string | null = null;
        const captureScreenshotSource = (source: unknown) => {
          if (resolvedLocalScreenshot || !source) return;
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
        if (hasMatchingCache && (cacheSnapshot?.chart || cacheSnapshot?.profile)) {
          savedChartPayload = {};
          if (cacheSnapshot?.chart) {
            savedChartPayload.chart = cacheSnapshot.chart;
            captureScreenshotSource(cacheSnapshot.chart);
          }
          if (cacheSnapshot?.profile) savedChartPayload.profile = cacheSnapshot.profile;
        } else if (savedChartRecord) {
          if (savedChartRecord.payload && isRecord(savedChartRecord.payload)) {
            savedChartPayload = savedChartRecord.payload;
          } else if (savedChartRecord.raw && isRecord(savedChartRecord.raw)) {
            savedChartPayload = savedChartRecord.raw as Record<string, unknown>;
          }
        }
        if (!savedChartPayload && viewingOwnProfile) {
          savedChartPayload = readSavedChartSource(currentUserId ?? undefined);
        }
        if (savedChartPayload) {
          captureScreenshotSource(savedChartPayload['chart']);
          if (!resolvedLocalScreenshot) {
            captureScreenshotSource(savedChartPayload);
          }
        } else if (viewingOwnProfile) {
          try {
            const fallbackSource = readSavedChartSource(currentUserId ?? undefined);
            if (fallbackSource) {
              captureScreenshotSource(fallbackSource['chart'] ?? fallbackSource);
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
                setChart((prev) => prev ?? toChartRow({ chart: normalizedChart }));
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
            setProfile(sanitizeOwnProfile(localSavedChartProfile));
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
          
        if (profileError) throw profileError;
        const normalizedCloudProfile = mergeProfileSnapshots(null, profileData?.data as Record<string, unknown>);
        if (!normalizedCloudProfile) {
          setProfile(sanitizeOwnProfile(localSavedChartProfile));
          if (!localSavedChartProfile) {
            setLoadingError('Профиль пользователя не найден.');
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
        setProfile(sanitizeOwnProfile(effectiveProfile));
        // Load latest chart (optional)
        const { data: chartData, error: chartError } = await supabase
          .from('charts')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
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
                      const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(match.name);
                      const publicURL = publicData?.publicUrl;
                      if (publicURL) {
                        finalChart = applyScreenshotToChart(finalChart, publicURL);
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
            setChart(finalChart);
          }
        }
      } catch (e) {
        console.error('Error loading profile:', e);
        setLoadingError('Не удалось загрузить профиль. Проверьте соединение или активность проекта Supabase.');
      }
    }
    void loadData();
  }, [userId, currentUserId, isOnline, sanitizeOwnProfile]);
  useEffect(() => {
    const blockedSet = new Set(blockedKeys);
    async function loadOtherProfiles() {
      if (!partnerSearchAllowed) {
        setOtherLoading(false);
        setOtherProfiles([]);
        return;
      }
      setOtherLoading(true);
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
                // filter by opposite gender if current profile gender known
                const g = profile?.gender;
                if (g === 'male' || g === 'female') {
                  cached = cached.filter((p) => p.gender && p.gender !== g);
                }
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
          return;
        }
        const { data, error } = await supabase
          .from('profiles')
          .select('id, data, last_seen_at')
          .neq('id', userId ?? '')
          .limit(5);
        if (error) {
          console.warn('Failed to load other profiles:', error);
          return;
        }
        if (!Array.isArray(data)) {
          setOtherProfiles([]);
          return;
        }
        let mapped = data
          .map((entry) => {
            if (!isRecord(entry) || typeof entry.id !== 'string') return null;
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
            const birth = typeof snapshot.birth === 'string' ? snapshot.birth : null;
            const ascSignFromProfile = typeof snapshot.ascSign === 'string' ? snapshot.ascSign : null;
            const gender = normalizeGender(snapshot.gender);
            const typeazh = typeof snapshot.typeazh === 'string' ? snapshot.typeazh : '';
            return {
              id: entry.id,
              personName,
              lastName,
              selectedCity,
              cityNameRu,
              residenceCountry,
              residenceCityName,
              mainPhoto,
              birth,
              ascSign: ascSignFromProfile,
              gender,
              typeazh,
              chartScreenshot: null,
              chart: null,
              chartSignature: null,
              lastSeenAt,
            } as OtherProfilePreview;
          })
          .filter((item): item is OtherProfilePreview => Boolean(item));
        // filter by opposite gender if current profile gender known
        const g = profile?.gender;
        if (g === 'male' || g === 'female') {
          mapped = mapped.filter((p) => p.gender && p.gender !== g);
        }
        const withCharts = await Promise.all(
          mapped.map(async (entry) => {
            let chartScreenshot: string | null = null;
            let chartPayload: ChartPayload = null;
            let finalAscSign = entry.ascSign;
            try {
              const { data: chartRow, error: chartErr } = await supabase
                .from('charts')
                .select('chart')
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
                chartScreenshot = extractChartScreenshot(normalized);
                if (chartScreenshot && needsSupabaseResolution(chartScreenshot)) {
                  const pointer = isRecord(normalized.chart) && typeof normalized.chart.screenshotStoragePointer === 'string'
                    ? normalized.chart.screenshotStoragePointer
                    : null;
                  chartScreenshot = await resolveSupabaseScreenshotUrl(pointer ?? chartScreenshot);
                }
                
                // Extract ascSign from chart if not in profile
                if (!finalAscSign) {
                  finalAscSign = extractAscSignFromChart(normalized);
                }
              }
            } catch (chartError) {
              console.warn('Unexpected chart preview error:', chartError);
            }
            const chartSignature = computeChartSignature(chartPayload);
            return { ...entry, chartScreenshot, chart: chartPayload, ascSign: finalAscSign, chartSignature };
          })
        );
        // Safety: повторно отфильтровать по противоположному полу после загрузки чартов
        const g2 = profile?.gender;
        const genderFiltered = (g2 === 'male' || g2 === 'female')
          ? withCharts.filter((p) => p.gender && p.gender !== g2)
          : withCharts;
        const finalList = blockedSet.size
          ? genderFiltered.filter((entry) => !blockedSet.has(entry.id))
          : genderFiltered;
        setOtherProfiles(finalList);
        try {
          localStorage.setItem(
            OTHER_PROFILES_CACHE_KEY,
            JSON.stringify({ userId: userId ?? null, entries: genderFiltered })
          );
        } catch (cacheSaveError) {
          console.warn('Не удалось сохранить кеш анкет других пользователей', cacheSaveError);
        }
      } catch (error) {
        console.warn('Unexpected error while loading other profiles:', error);
      } finally {
        setOtherLoading(false);
      }
    }
    void loadOtherProfiles();
  }, [userId, isOnline, profile?.gender, blockedKeys, partnerSearchAllowed]);

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
              error: 'Натальная карта не найдена.',
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
        {loadingError}
        <div className="mt-2 text-sm text-white/70">
          Если проект Supabase поставлен на паузу, возобновите его в консоли Supabase и обновите страницу.
        </div>
      </div>
    );
  }
  if (!profile) {
    return <div className="p-8">Загрузка данных пользователя...</div>;
  }
  const screenshotUrl = chart ? extractChartScreenshot(chart) : null;
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
  const ageText = age !== null ? ` (${age} лет)` : '';
  const genderText = profile.gender === 'male' ? 'мужской' : profile.gender === 'female' ? 'женский' : '—';
  const profileCityLabel = getCityLabel(profile.cityNameRu, profile.selectedCity);
  const profileResidenceLabel = formatResidenceLabel(profile.residenceCityName, profile.residenceCountry);
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto p-8">
      {!isOnline && (
        <div className="mb-6 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-200">
          Нет подключения к сети. Показаны закэшированные данные профиля и анкет.
        </div>
      )}
      <header className="mb-8">
        <div className="flex justify-between items-center mb-2">
          <h1 className="text-3xl font-bold">{profile.personName} {profile.lastName}</h1>
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
              Натальная карта
            </button>
            <button
              onClick={() => navigate(fromFileRef.current ? '/questionnaire?fromFile=1' : '/questionnaire')}
              className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`}
            >
              Изменить анкету
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
          </div>
        </div>
        {identityEmail && isOwnProfile ? (
          <div className="text-sm text-white/60 mb-2">{'\u0412\u0430\u0448 \u043b\u043e\u0433\u0438\u043d: '}{identityEmail}</div>
        ) : null}
        <div className="text-base text-gray-600">
          Локальное время: {profile.birth?.replace('T', '; T') || '—'}{ageText}<br />
          Восходящий знак: {ascSign || '—'}<br />
          Пол: {genderText}<br />
          Место рождения: {profileCityLabel || '—'}<br />
          Место жительства: {profileResidenceLabel || '—'}
        </div>
      </header>
      <div className="user-profile-layout">
        <div className="user-profile-left space-y-3">
          {/* Main photo and thumbnails with highlight */}
          <div className="user-profile-card">
            <div className="flex gap-4 items-start">
              {profile.mainPhoto ? (
                <div className="bg-white border border-blue-300 rounded-lg p-1 max-w-[200px] overflow-hidden">
                  <img src={profile.mainPhoto} alt="Главное фото" className="block w-[200px] h-[286px] object-cover rounded-lg" />
                </div>
              ) : (
                <div className="bg-white/50 border border-dashed border-blue-300 rounded-lg p-4 max-w-[200px] h-[286px] flex items-center justify-center text-sm text-blue-500">
                  Нет фото
                </div>
              )}
              <div className="flex flex-col gap-3">
                {profile.smallPhotos?.map((photo, idx) => (
                  photo ? (
                    <div key={idx} className="bg-white border border-blue-200 rounded p-1 w-[142px] h-[142px] overflow-hidden">
                      <img src={photo} alt={`Фото ${idx + 1}`} className="block w-full h-full object-cover rounded" />
                    </div>
                  ) : (
                    <div key={idx} className="bg-white/50 border border-dashed border-blue-200 rounded p-1 w-[142px] h-[142px] flex items-center justify-center text-xs text-blue-500">
                      Нет фото
                    </div>
                  )
                ))}
              </div>
            </div>
          </div>
          {/* Chart screenshot */}
          <div className="user-profile-card flex flex-col items-start">
            <div className="bg-white border border-blue-200 rounded-lg p-2 mb-2 w-full overflow-hidden">
              {screenshotUrl ? (
                <img src={screenshotUrl} alt="Скриншот карты" className="block w-full max-w-[360px] h-[240px] object-contain mx-auto" />
              ) : (
                <div className="w-[240px] h-[240px] flex items-center justify-center text-gray-400 mx-auto">Нет скриншота карты</div>
              )}
            </div>
          </div>
          {/* Profile info after chart */}
          <div className="user-profile-card">
            <div className="mb-3">
              <h3 className="text-lg font-semibold leading-tight mb-1">Типаж</h3>
              <div className="text-base leading-snug whitespace-pre-line">{profile.typeazh || 'Не указано'}</div>
            </div>
            <div className="mb-3">
              <h3 className="text-lg font-semibold leading-tight mb-1">Семейное положение</h3>
              <div className="text-base leading-snug whitespace-pre-line">{profile.familyStatus || 'Не указано'}</div>
            </div>
            <div className="mb-3">
              <h3 className="text-lg font-semibold leading-tight mb-1">О себе</h3>
              <div className="text-base leading-snug whitespace-pre-line">{profile.about || 'Не указано'}</div>
            </div>
            <div className="mb-3">
              <h3 className="text-lg font-semibold leading-tight mb-1">Интересы</h3>
              <div className="text-base leading-snug whitespace-pre-line">{profile.interests || 'Не указано'}</div>
            </div>
            <div className="mb-3">
              <h3 className="text-lg font-semibold leading-tight mb-1">Карьера, образование</h3>
              <div className="text-base leading-snug whitespace-pre-line">{profile.career || 'Не указано'}</div>
            </div>
            <div>
              <h3 className="text-lg font-semibold leading-tight mb-1">Дети</h3>
              <div className="text-base leading-snug whitespace-pre-line">{profile.children || 'Не указано'}</div>
            </div>
          </div>
        </div>
        <aside className="user-profile-sidebar sticky top-24 h-[calc(100vh-6rem)] overflow-hidden">
          <div className="user-profile-scroll h-full overflow-y-auto">
            <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4 flex flex-col h-full">
              <h2 className="text-lg font-semibold text-white mb-3">Анкеты других пользователей</h2>
              <div className="flex-1 pr-1">
                {partnerSearchLocked ? (
                  <div className="text-sm text-white/80 border border-white/10 bg-white/5 rounded-md px-3 py-4 text-center flex flex-col gap-3 items-center">
                    <div>Приобретите лицензию для поиска партнёра.</div>
                    <button
                      type="button"
                      onClick={requestPurchaseDialog}
                      className={`${BUTTON_PRIMARY} px-4 py-1.5 text-sm`}
                    >
                      Купить лицензию
                    </button>
                  </div>
                ) : otherLoading ? (
                  <div className="text-sm text-white/70">Идёт загрузка анкет...</div>
                ) : !selfGender ? (
                  <div className="text-sm text-white/80">
                    Укажите пол в анкете, чтобы видеть подходящие профили и открывать чат.
                  </div>
                ) : visibleOtherProfiles.length === 0 ? (
                  <div className="text-sm text-white/70">
                    {isOnline ? 'Анкеты пока не найдены.' : 'Нет подключения: список анкет недоступен.'}
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {visibleOtherProfiles.map((entry) => {
                      const fullName = (entry.personName || 'Имя не указано') + (entry.lastName ? ` ${entry.lastName}` : '');
                      const age = calculateAge(entry.birth);
                      const genderLabel = entry.gender === 'male' ? 'мужской' : entry.gender === 'female' ? 'женский' : '—';
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
                      const statusBadge = describeOnlineStatus(entry.lastSeenAt);
                      return (
                        <li
                          key={entry.id}
                          className="rounded-lg border border-white/10 bg-white/5 p-3 hover:border-blue-400 transition-colors flex flex-col gap-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-3 flex-wrap">
                                <div className="text-sm font-bold text-white truncate max-w-[220px] mr-1" style={{ fontWeight: 700 }}>
                                  {fullName}
                                </div>
                                <span
                                  className={`inline-flex shrink-0 items-center rounded-full border px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide mt-0.5 ${statusBadge.badgeClass}`}
                                  title={statusBadge.title}
                                  style={{ ...statusBadge.style, marginLeft: '10px' }}
                                >
                                  {statusBadge.label}
                                </span>
                              </div>
                              <div className="text-xs text-white/60">{age !== null ? `${age} лет` : 'Возраст не указан'}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleOpenChat(entry)}
                              className={`px-3 py-1 border border-black text-xs font-semibold whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                hasUnread ? 'bg-[#f0c0c0]' : 'bg-[#f5d6ab]'
                              }`}
                              disabled={
                                !currentUserId ||
                                !selfGender ||
                                !entry.gender ||
                                entry.gender === selfGender ||
                                partnerSearchLocked
                              }
                              title={
                                !currentUserId
                                  ? 'Требуется вход в учётную запись'
                                  : !selfGender
                                    ? 'Укажите свой пол, чтобы открыть чат'
                                    : !entry.gender || entry.gender === selfGender
                                      ? 'Чат доступен только с противоположным полом'
                                      : partnerSearchLocked
                                        ? 'Для чата нужен активный доступ поиска партнёров'
                                        : 'Открыть окно чата'
                              }
                            >
                              {chatLabel}
                            </button>
                          </div>
                          <div className="flex flex-row flex-wrap gap-3 md:gap-4 md:flex-nowrap md:items-stretch">
                            <div className="w-[72px] h-[100px] bg-white/10 border border-white/20 rounded overflow-hidden flex-shrink-0">
                              {entry.mainPhoto ? (
                                <img src={entry.mainPhoto} alt={entry.personName || 'Главное фото'} className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-xs text-white/60 text-center px-1">Нет фото</div>
                              )}
                            </div>
                            <div className="w-[140px] h-[100px] bg-white/10 border border-white/20 rounded overflow-hidden flex-shrink-0">
                              {entry.chartScreenshot ? (
                                <img src={entry.chartScreenshot} alt="Скриншот карты" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-xs text-white/60 text-center px-1">
                                  Нет скриншота карты
                                </div>
                              )}
                            </div>
                            <div className="flex-1 bg-white/5 border border-white/10 rounded p-2 text-xs text-white/80 space-y-1 md:max-w-[280px]">
                              <div><span className="text-white font-semibold">Пол:</span> {genderLabel}</div>
                              <div><span className="text-white font-semibold">Место рождения:</span> {birthPlaceLabel || '—'}</div>
                              <div><span className="text-white font-semibold">Место жительства:</span> {residenceLabel || '—'}</div>
                              <div><span className="text-white font-semibold">Восходящий знак:</span> {entry.ascSign || '—'}</div>
                              <div><span className="text-white font-semibold">Совместимость:</span> {compatibilityLabel}</div>
                              <div><span className="text-white font-semibold">Куджа-доша:</span> {kujaLabel}</div>
                              {offlineCached && (
                                <div className="text-white/50">Данные из локального кеша</div>
                              )}
                              <div className="pt-1"><span className="text-white font-semibold">Типаж:</span> <span className="text-white/70">{typeazhPreview || 'Не указано'}</span></div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
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

