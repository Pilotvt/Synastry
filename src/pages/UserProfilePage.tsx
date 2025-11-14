import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { scoreSynastry, type ChartPayload } from '../synastry/scoring';
import { applyKujaPenaltySimple } from '../synastry/kuja_simple';
import { analyzeKujaDosha } from '../synastry/kuja';
import { getExpressionCompatByDate } from '../numerology/exprDate/getExpressionByDate';
import { WEIGHTS } from '../synastry/weights';
import { computeDirectionalSynastry } from '../synastry/directionalSummary';
import { useNetStatus } from '../context/NetStatusContext';
import './UserProfilePage.css';
import { latinToRuName } from '../utils/transliterate';
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
// Минимальный тип статуса лицензии (для email в профиле)
type ElectronLicenseStatus = {
  identityEmail?: string | null;
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
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
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
  if (isRecord(chartValue) && typeof chartValue.screenshotUrl === 'string') {
    return chartValue.screenshotUrl;
  }
  return null;
};
const applyScreenshotToChart = (row: ChartRow, screenshotUrl: string): ChartRow => {
  const chartValue = isRecord(row.chart) ? row.chart : {};
  return { ...row, chart: { ...chartValue, screenshotUrl } };
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

const regionNames =
  typeof Intl !== 'undefined' && typeof (Intl as any).DisplayNames === 'function'
    ? new Intl.DisplayNames(['ru'], { type: 'region' })
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
const OTHER_PROFILES_CACHE_KEY = 'synastry_cached_other_profiles_v1';
const STORAGE_KEY = 'synastry_ui_histtz_v2';
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
  const personName = typeof value.personName === 'string' ? value.personName : '';
  const lastName = typeof value.lastName === 'string' ? value.lastName : '';
  const selectedCity = typeof value.selectedCity === 'string' ? value.selectedCity : '';
  const cityNameRuRaw = typeof (value as any).cityNameRu === 'string' ? (value as any).cityNameRu : '';
  const cityNameRu = cityNameRuRaw || (selectedCity ? latinToRuName(selectedCity) : '');
  const residenceCountry = typeof (value as any).residenceCountry === 'string' ? (value as any).residenceCountry : '';
  const residenceCityName = typeof (value as any).residenceCityName === 'string' ? (value as any).residenceCityName : '';
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
  };
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
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [otherProfiles, setOtherProfiles] = useState<OtherProfilePreview[]>([]);
  const [otherLoading, setOtherLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [compatibilityMap, setCompatibilityMap] = useState<Record<string, CompatibilityPreview>>({});
  const compatibilityRef = useRef<Record<string, CompatibilityPreview>>({});
  const { isOnline } = useNetStatus();
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
  const handleOpenChat = useCallback((entry: OtherProfilePreview) => {
    if (typeof window === 'undefined') return;
    const encoded = encodeChatPayload(entry);
    if (!encoded) return;
    const api = (window as any).electronAPI?.chat;
    if (api?.open) {
      api.open(encoded);
      return;
    }
    const [base] = window.location.href.split('#');
    const url = `${base || window.location.href}#/chat-popup?data=${encoded}`;
    window.open(url, `chat-${entry.id}`, 'width=520,height=640,resizable=yes,menubar=no,toolbar=no')?.focus();
  }, [encodeChatPayload]);
  // Получаем email пользователя из Electron (main) и показываем под именем
  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      const api = (typeof window !== 'undefined') ? (window as any).electronAPI?.license : undefined;
      if (api?.getStatus) {
        api.getStatus().then((s: ElectronLicenseStatus | null) => {
          if (s && s.identityEmail) setIdentityEmail(s.identityEmail);
        }).catch(() => {});
      }
      if (api?.onStatus) {
        unsub = api.onStatus((s: ElectronLicenseStatus | null) => {
          if (s && s.identityEmail) setIdentityEmail(s.identityEmail);
        });
      }
    } catch {}
    return () => { try { unsub?.(); } catch {} };
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
    } catch {}
    return () => {
      try {
        subscription?.unsubscribe();
      } catch {}
    };
  }, []);

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
    async function loadData() {
      if (!userId) return;
      
      try {
        setLoadingError(null);
        // Мгновенная загрузка из localStorage (если есть) — отображаем сразу
        let localInitialProfile: UserProfile | null = null;
        try {
          const localRaw = localStorage.getItem(STORAGE_KEY);
          if (localRaw) {
            const parsed = JSON.parse(localRaw) as unknown;
            const snapshot = (parsed && typeof parsed === 'object' && (parsed as any).profile)
              ? (parsed as any).profile
              : parsed;
            localInitialProfile = mergeProfileSnapshots(snapshot as Record<string, unknown>, null);
            if (localInitialProfile) {
              setProfile(localInitialProfile);
            }
          }
        } catch (e) {
          // ignore local parse errors
        }
        const localInitialFp = personFingerprint(localInitialProfile);
        let localSavedChartProfile: UserProfile | null = null;
        try {
          const savedChart = localStorage.getItem('synastry_saved_chart_data');
          if (savedChart) {
            const parsedChart = JSON.parse(savedChart) as unknown;
            if (parsedChart && typeof parsedChart === 'object') {
              const chartObj = (parsedChart as any).chart ?? parsedChart;
              const savedProfile = (parsedChart as any).profile;
              if (savedProfile && typeof savedProfile === 'object') {
                localSavedChartProfile = mergeProfileSnapshots(savedProfile as Record<string, unknown>, null);
              }
              if (chartObj && typeof chartObj === 'object') {
                setChart(toChartRow({ chart: chartObj }));
              }
            }
          }
        } catch (e) {
          // ignore local chart errors
        }
        const localSavedChartFp = personFingerprint(localSavedChartProfile);
        if (localSavedChartProfile) {
          const preferChartProfile =
            !localInitialProfile ||
            !localInitialFp ||
            (localSavedChartFp && localInitialFp && localSavedChartFp !== localInitialFp);
          if (preferChartProfile) {
            setProfile(localSavedChartProfile);
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
          setProfile(localSavedChartProfile);
          if (!localSavedChartProfile) {
            setLoadingError('Профиль пользователя не найден.');
            return;
          }
        }
        const cloudFp = personFingerprint(normalizedCloudProfile);
        const savedChartFp = personFingerprint(localSavedChartProfile);
        const chartOverridesCloud = Boolean(localSavedChartProfile && savedChartFp && cloudFp && savedChartFp !== cloudFp);
        let effectiveProfile: UserProfile | null = null;
        if (chartOverridesCloud && localSavedChartProfile) {
          effectiveProfile = localSavedChartProfile;
        } else if (localInitialProfile) {
          effectiveProfile =
            mergeProfileSnapshots(localInitialProfile, profileData?.data as Record<string, unknown>) ?? normalizedCloudProfile ?? localSavedChartProfile;
        } else {
          effectiveProfile = normalizedCloudProfile ?? localSavedChartProfile;
        }
        setProfile(effectiveProfile);
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
        let finalChart: ChartRow | null = null;
        if (chartData) {
          finalChart = toChartRow(chartData);
          try {
            if (!extractChartScreenshot(finalChart)) {
              const raw = localStorage.getItem('synastry_saved_chart_data');
              if (raw) {
                try {
                  const parsed = JSON.parse(raw) as unknown;
                  const localScreenshot = extractChartScreenshot(toChartRow(parsed));
                  if (typeof localScreenshot === 'string') {
                    finalChart = applyScreenshotToChart(finalChart, localScreenshot);
                  }
                } catch (storageError) {
                  console.warn('Failed to parse saved chart screenshot from localStorage', storageError);
                }
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
          const shouldSkipOverride = Boolean(savedFp && cloudPersonFp && savedFp !== cloudPersonFp);
          const profileForCache =
            chartOverridesCloud && localSavedChartProfile
              ? localSavedChartProfile
              : (effectiveProfile ?? normalizedCloudProfile ?? localSavedChartProfile);
          if (!shouldSkipOverride) {
            try {
              const chartCachePayload = {
                ...finalChart,
                profile: profileForCache,
                cachedAt: Date.now(),
              };
              localStorage.setItem('synastry_saved_chart_data', JSON.stringify(chartCachePayload));
            } catch (chartCacheError) {
              console.warn('Не удалось сохранить карту в локальный кеш', chartCacheError);
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
  }, [userId, isOnline, profile?.gender]);
  useEffect(() => {
    async function loadOtherProfiles() {
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
                setOtherProfiles(cached);
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
          .select('id, data')
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
                
                // Extract ascSign from chart if not in profile
                if (!finalAscSign) {
                  finalAscSign = extractAscSignFromChart(normalized);
                }
              }
            } catch (chartError) {
              console.warn('Unexpected chart preview error:', chartError);
            }
            return { ...entry, chartScreenshot, chart: chartPayload, ascSign: finalAscSign };
          })
        );
        // Safety: повторно отфильтровать по противоположному полу после загрузки чартов
        const g2 = profile?.gender;
        const finalList = (g2 === 'male' || g2 === 'female')
          ? withCharts.filter((p) => p.gender && p.gender !== g2)
          : withCharts;
        setOtherProfiles(finalList);
        try {
          localStorage.setItem(
            OTHER_PROFILES_CACHE_KEY,
            JSON.stringify({ userId: userId ?? null, entries: withCharts })
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
  }, [userId, isOnline, profile?.gender]);
  useEffect(() => {
    updateCompatibilityMap((prev) => {
      const next: Record<string, CompatibilityPreview> = {};
      for (const entry of otherProfiles) {
        if (prev[entry.id]) {
          next[entry.id] = prev[entry.id];
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
        const existing = compatibilityRef.current[entry.id];
        if (existing && existing.status === 'ready') {
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
            },
          }));
          continue;
        }
        updateCompatibilityMap((prev) => {
          const current = prev[entry.id];
          if (current && current.status === 'ready') return prev;
          return {
            ...prev,
            [entry.id]: {
              status: 'loading',
              percent: null,
              basePercent: null,
              kujaPenalty: null,
              hasCurrentKuja: baseHasKuja,
              hasOtherKuja: false,
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
  
  // Resolve ascendant sign with fallback logic (like in Questionnaire)
  const ascSign = (() => {
    // 1. Check profile.ascSign
    const profileAsc = typeof profile.ascSign === 'string' ? profile.ascSign.trim() : '';
    if (profileAsc) return profileAsc;
    
    // 2. Extract from chart data
    const chartAsc = extractAscSignFromChart(chart);
    if (chartAsc) return chartAsc;
    
    // 3. Try localStorage fallback
    try {
      const raw = localStorage.getItem('synastry_saved_chart_data');
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (isRecord(parsed)) {
          const localChart = isRecord(parsed.chart) ? parsed.chart : null;
          if (localChart) {
            const localAsc = extractAscSignFromChart(toChartRow({ chart: localChart }));
            if (localAsc) return localAsc;
          }
          const localProfile = isRecord(parsed.profile) ? parsed.profile : null;
          if (localProfile && typeof localProfile.ascSign === 'string') {
            return localProfile.ascSign;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to read ascSign from localStorage', err);
    }
    
    return null;
  })();
  
  const age = calculateAge(profile.birth);
  const ageText = age !== null ? ` (${age} лет)` : '';
  const genderText = profile.gender === 'male' ? 'мужской' : profile.gender === 'female' ? 'женский' : '—';
  const isOwnProfile = Boolean(currentUserId && userId && currentUserId === userId);
  const profileCityLabel = getCityLabel(profile.cityNameRu, profile.selectedCity);
  const profileResidenceLabel = formatResidenceLabel(profile.residenceCityName, profile.residenceCountry);
  return (
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
              onClick={() => navigate("/app")}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
            >
              Новая карта
            </button>
            <button
              onClick={() => navigate('/chart')}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
            >
              Натальная карта
            </button>
            <button
              onClick={() => navigate('/questionnaire')}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
            >
              Изменить анкету
            </button>
            <button
              disabled
              className="px-3 py-1.5 bg-indigo-600 border border-indigo-300 rounded text-sm cursor-default"
            >
              Профиль
            </button>
            <button
              onClick={() => navigate('/sinastry')}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
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
                <div className="bg-white border border-blue-300 rounded-lg p-1 max-w-[200px]">
                  <img src={profile.mainPhoto} alt="Главное фото" className="w-[200px] h-[286px] object-cover rounded-lg" />
                </div>
              ) : (
                <div className="bg-white/50 border border-dashed border-blue-300 rounded-lg p-4 max-w-[200px] h-[286px] flex items-center justify-center text-sm text-blue-500">
                  Нет фото
                </div>
              )}
              <div className="flex flex-col gap-3">
                {profile.smallPhotos?.map((photo, idx) => (
                  photo ? (
                    <div key={idx} className="bg-white border border-blue-200 rounded p-1 w-[142px] h-[142px]">
                      <img src={photo} alt={`Фото ${idx + 1}`} className="w-full h-full object-cover rounded" />
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
            <div className="bg-white border border-blue-200 rounded-lg p-2 mb-2 w-full">
              {screenshotUrl ? (
                <img src={screenshotUrl} alt="Скриншот карты" className="w-full max-w-[360px] h-[240px] object-contain mx-auto" />
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
                {otherLoading ? (
                  <div className="text-sm text-white/70">Идёт загрузка анкет...</div>
                ) : otherProfiles.length === 0 ? (
                  <div className="text-sm text-white/70">
                    {isOnline ? 'Анкеты пока не найдены.' : 'Нет подключения: список анкет недоступен.'}
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {otherProfiles.map((entry) => {
                      const fullName = (entry.personName || 'Имя не указано') + (entry.lastName ? ` ${entry.lastName}` : '');
                      const age = calculateAge(entry.birth);
                      const genderLabel = entry.gender === 'male' ? 'мужской' : entry.gender === 'female' ? 'женский' : '—';
                      const compat = compatibilityMap[entry.id];
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
                      return (
                        <li
                          key={entry.id}
                          className="rounded-lg border border-white/10 bg-white/5 p-3 hover:border-blue-400 transition-colors flex flex-col gap-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-white truncate">{fullName}</div>
                              <div className="text-xs text-white/60">{age !== null ? `${age} лет` : 'Возраст не указан'}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleOpenChat(entry)}
                              className="text-xs font-semibold text-blue-300 hover:text-blue-100 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                              disabled={!currentUserId}
                              title={currentUserId ? 'Открыть окно чата' : 'Требуется вход в учётную запись'}
                            >
                              Написать
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
  );
};
export default UserProfilePage;





