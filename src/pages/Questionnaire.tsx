import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { saveChart, type JsonValue } from "../lib/charts";
import { latinToRuName } from "../utils/transliterate";
import { useProfile } from "../store/profile";
import { getRussianCities, findNearestRussianCity } from "../utils/russianCitiesClient";

const STORAGE_KEY = "synastry_ui_histtz_v2";
const SAVED_CHART_KEY = "synastry_saved_chart_data";
const LAST_SAVED_CHART_FINGERPRINT_KEY = "synastry_chart_last_saved_fp";
const LAST_SAVED_FINGERPRINT_KEY = "synastry_profile_last_saved_fp";

const SIGN_NAMES_RU: Record<string, string> = {
  Ar: "Овен",
  Ta: "Телец",
  Ge: "Близнецы",
  Cn: "Рак",
  Le: "Лев",
  Vi: "Дева",
  Li: "Весы",
  Sc: "Скорпион",
  Sg: "Стрелец",
  Cp: "Козерог",
  Aq: "Водолей",
  Pi: "Рыбы",
};

type ProfileSnapshot = {
  personName?: string;
  lastName?: string;
  birth?: string;
  gender?: "male" | "female";
  country?: string;
  cityQuery?: string;
  selectedCity?: string;
  cityNameRu?: string;
  residenceCountry?: string;
  residenceCityName?: string;
  manual?: boolean;
  lat?: number;
  lon?: number;
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
  ascSign?: string;
  updated_at?: number;
};

type ResidenceCityOption = {
  id: string;
  name: string;
  nameRu: string;
};

type SaveControlsProps = { navigate: (to: string) => void; getProfileSnapshot?: () => ProfileSnapshot | null };

const EMPTY_SMALL_PHOTOS: (string | null)[] = [null, null];

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null;
}

function normalizeSnapshotForFingerprint(snapshot: ProfileSnapshot | null | undefined): Record<string, unknown> | null {
  if (!snapshot) return null;
  const { updated_at: _ignored, smallPhotos, mainPhoto, ...rest } = snapshot;
  return {
    ...rest,
    mainPhoto: typeof mainPhoto === "string" ? mainPhoto : null,
    smallPhotos: normalizeSmallPhotos(smallPhotos),
  };
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

function computeSnapshotFingerprint(snapshot: ProfileSnapshot | null | undefined): string | null {
  const normalized = normalizeSnapshotForFingerprint(snapshot);
  if (!normalized) return null;
  return stableStringify(sanitizeForFingerprint(normalized));
}

function computeChartFingerprint(chart: unknown, meta: unknown): string | null {
  if (!chart && !meta) return null;
  const payload: Record<string, unknown> = {};
  if (chart && typeof chart === "object") {
    payload.chart = sanitizeForFingerprint(chart);
  }
  if (meta && typeof meta === "object") {
    payload.meta = sanitizeForFingerprint(meta);
  }
  return Object.keys(payload).length > 0 ? stableStringify(payload) : null;
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

const COUNTRY_RU_NAMES: Record<string, string> = {
  RU: "Россия",
  UA: "Украина",
  BY: "Беларусь",
  KZ: "Казахстан",
  US: "США",
  CN: "Китай",
  IN: "Индия",
  GB: "Великобритания",
  DE: "Германия",
  FR: "Франция",
  IT: "Италия",
  ES: "Испания",
  PT: "Португалия",
  PL: "Польша",
  TR: "Турция",
  // fallback handled below
};

function countryNameRU(code: string) {
  const upper = (code || "").toUpperCase();
  return COUNTRY_RU_NAMES[upper] || upper;
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
  region_ru?: string;
};

function readLastSavedFingerprint(): string | null {
  try {
    return localStorage.getItem(LAST_SAVED_FINGERPRINT_KEY);
  } catch (error) {
    console.warn("Failed to read last saved fingerprint", error);
    return null;
  }
}

function writeLastSavedFingerprint(fingerprint: string | null): void {
  try {
    if (!fingerprint) {
      localStorage.removeItem(LAST_SAVED_FINGERPRINT_KEY);
    } else {
      localStorage.setItem(LAST_SAVED_FINGERPRINT_KEY, fingerprint);
    }
  } catch (error) {
    console.warn("Failed to persist last saved fingerprint", error);
  }
}

function readLastSavedChartFingerprint(): string | null {
  try {
    return localStorage.getItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
  } catch (error) {
    console.warn("Failed to read last saved chart fingerprint", error);
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
    console.warn("Failed to persist last saved chart fingerprint", error);
  }
}

function extractProfileSnapshotFromRaw(raw: unknown): ProfileSnapshot | null {
  if (!isRecord(raw)) return null;
  const container = raw as Record<string, JsonValue>;
  const candidateRaw = "profile" in container ? container.profile : raw;
  if (isRecord(candidateRaw)) {
    const snapshot = candidateRaw as ProfileSnapshot;
    if ((!snapshot.cityNameRu || !snapshot.cityNameRu.trim()) && typeof snapshot.selectedCity === "string") {
      snapshot.cityNameRu = latinToRuName(snapshot.selectedCity);
    }
    return snapshot;
  }
  const fallback = container as ProfileSnapshot;
  if ((!fallback.cityNameRu || !fallback.cityNameRu.trim()) && typeof fallback.selectedCity === "string") {
    fallback.cityNameRu = latinToRuName(fallback.selectedCity);
  }
  return fallback;
}

function readStoredProfileSnapshot(): ProfileSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return extractProfileSnapshotFromRaw(parsed);
  } catch (error) {
    console.warn("Failed to read stored profile snapshot", error);
    return null;
  }
}

// Build a person identity fingerprint using core fields. If these change, it's a different person.
function personFingerprint(p: ProfileSnapshot | null | undefined): string {
  if (!p) return "";
  const name = (p.personName ?? "").trim().toLowerCase();
  const last = (p.lastName ?? "").trim().toLowerCase();
  const birth = (p.birth ?? "").trim();
  const city = (p.selectedCity ?? p.cityQuery ?? "").trim().toLowerCase();
  const lat = typeof p.lat === 'number' ? p.lat.toFixed(4) : '';
  const lon = typeof p.lon === 'number' ? p.lon.toFixed(4) : '';
  return [name, last, birth, city, lat, lon].join('|');
}

function normalizeSmallPhotos(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) {
    return [...EMPTY_SMALL_PHOTOS];
  }
  const normalized = value.slice(0, 2);
  while (normalized.length < 2) {
    normalized.push(null);
  }
  return normalized.map((item) => (typeof item === "string" ? item : null));
}

function extractChartPayloadForExport(raw: unknown): {
  chart: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  screenshot: string | null;
  profile: ProfileSnapshot | null;
} {
  if (!isRecord(raw)) {
    return { chart: null, meta: null, screenshot: null, profile: null };
  }

  const root = raw as Record<string, unknown>;
  const chartContainer = isRecord(root.chart) ? (root.chart as Record<string, unknown>) : null;
  const nestedChart = chartContainer && isRecord(chartContainer.chart)
    ? (chartContainer.chart as Record<string, unknown>)
    : chartContainer;
  const chart = nestedChart ? { ...nestedChart } : null;

  let meta: Record<string, unknown> | null = null;
  if (isRecord(root.meta)) {
    meta = { ...(root.meta as Record<string, unknown>) };
  } else if (chartContainer && isRecord(chartContainer.meta)) {
    meta = { ...(chartContainer.meta as Record<string, unknown>) };
  }

  const profileCandidate = extractProfileSnapshotFromRaw(root.profile ?? null)
    ?? (chartContainer ? extractProfileSnapshotFromRaw(chartContainer.profile ?? null) : null);

  const screenshotCandidates: Array<string | null> = [
    typeof root.screenshot === "string" ? (root.screenshot as string) : null,
    chartContainer && typeof chartContainer["screenshot"] === "string" ? (chartContainer["screenshot"] as string) : null,
    chartContainer && typeof chartContainer["screenshotUrl"] === "string" ? (chartContainer["screenshotUrl"] as string) : null,
    chart && typeof chart["screenshot"] === "string" ? (chart["screenshot"] as string) : null,
    chart && typeof chart["screenshotUrl"] === "string" ? (chart["screenshotUrl"] as string) : null,
  ];
  const screenshot = screenshotCandidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;

  if (chart && screenshot) {
    chart["screenshotUrl"] = screenshot;
  }

  return {
    chart,
    meta,
    screenshot,
    profile: profileCandidate,
  };
}

function extractAscSignFromChart(chartValue: unknown): string | null {
  if (!isRecord(chartValue)) return null;

  const ascValue = chartValue.ascendant;
  if (isRecord(ascValue) && typeof ascValue.sign === "string") {
    return SIGN_NAMES_RU[ascValue.sign] ?? ascValue.sign;
  }

  const housesValue = chartValue.houses;
  if (Array.isArray(housesValue)) {
    for (const house of housesValue) {
      if (!isRecord(house)) continue;
      const houseNumber = typeof house.house === "number" ? house.house : Number(house.house);
      const signCode = typeof house.sign === "string" ? house.sign : "";
      if (houseNumber === 1 && signCode) {
        return SIGN_NAMES_RU[signCode] ?? signCode;
      }
    }
  }

  const layout = chartValue.north_indian_layout;
  if (isRecord(layout) && Array.isArray(layout.boxes)) {
    for (const box of layout.boxes) {
      if (!isRecord(box)) continue;
      const houseNumber = typeof box.house === "number" ? box.house : Number(box.house);
      const signCode = typeof box.sign === "string" ? box.sign : "";
      if (houseNumber === 1 && signCode) {
        return SIGN_NAMES_RU[signCode] ?? signCode;
      }
    }
  }

  return null;
}

function readStoredAscSign(): string | null {
  try {
    const raw = localStorage.getItem(SAVED_CHART_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const chartValue = parsed.chart ?? null;
    const ascFromChart = extractAscSignFromChart(chartValue);
    if (ascFromChart) return ascFromChart;

    // Sometimes ascendant info might be nested inside profile snapshot
    const profileValue = parsed.profile ?? null;
    if (isRecord(profileValue) && typeof profileValue.ascSign === "string") {
      return profileValue.ascSign;
    }

    return null;
  } catch (error) {
    console.warn("Failed to read stored ascendant sign", error);
    return null;
  }
}

function SaveControls({ navigate, getProfileSnapshot }: SaveControlsProps) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function saveProfileAndMaybeChart(navigateAfter = false) {
    setMsg(null);
    setSaving(true);
    try {
      let snapshot = getProfileSnapshot ? getProfileSnapshot() : null;
      if (!snapshot) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) throw new Error("Нет локального профиля для сохранения.");
        const parsed = JSON.parse(raw) as unknown;
        snapshot = extractProfileSnapshotFromRaw(parsed);
      }
      if (!snapshot) throw new Error("Не удалось собрать данные профиля.");

      let fingerprint = computeSnapshotFingerprint(snapshot);
      const lastFingerprint = readLastSavedFingerprint();
      let chartFingerprint: string | null = null;
      let lastChartFingerprint = readLastSavedChartFingerprint();

      const navigateToChart = () => {
        try {
          const raw = localStorage.getItem(SAVED_CHART_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.chart && parsed.meta) {
              navigate('/chart?fromFile=1');
              return;
            }
          }
        } catch (e) {
          // ignore, fall back to default navigation
        }
        navigate('/chart');
      };

      if (navigateAfter && fingerprint && lastFingerprint && fingerprint === lastFingerprint) {
        setMsg('Изменений нет, открываем карту.');
        navigateToChart();
        return;
      }

      // Stamp freshness and save locally first
      const stamped: ProfileSnapshot = { ...(snapshot ?? {}), updated_at: Date.now() };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile: stamped }));
        
        // Also update profile in saved chart data so Synastry page sees the changes
        const savedChartRaw = localStorage.getItem(SAVED_CHART_KEY);
        if (savedChartRaw) {
          try {
            const savedChartData = JSON.parse(savedChartRaw);
            savedChartData.profile = stamped;
            localStorage.setItem(SAVED_CHART_KEY, JSON.stringify(savedChartData));
          } catch (e) {
            console.warn("Failed to update profile in saved chart data:", e);
          }
        }
      } catch (storageError) {
        console.warn("Failed to save profile snapshot to localStorage:", storageError);
      }

      // Upsert profile into profiles table using current session user id
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (!userId) throw new Error("Пользователь не авторизован.");

  const payload = { id: userId, data: stamped };
      const { error: upsertErr } = await supabase.from('profiles').upsert(payload);
      if (upsertErr) throw upsertErr;

      // Save chart if we have a request in localStorage
      try {
        const saved = localStorage.getItem(SAVED_CHART_KEY);
        if (saved) {
          const parsedSaved = JSON.parse(saved) as Record<string, JsonValue>;
          const chart = (parsedSaved.chart ?? null) as JsonValue | null;
          const meta = (parsedSaved.meta ?? null) as JsonValue | null;
          chartFingerprint = computeChartFingerprint(chart, meta);
          const shouldSaveChart = Boolean(chart && chartFingerprint && chartFingerprint !== lastChartFingerprint);
          if (chart) {
            if (shouldSaveChart) {
              const name = `${snapshot?.personName ?? 'chart'} ${new Date().toLocaleString()}`;
              await saveChart(userId, name, 'private', snapshot, chart, meta ?? undefined);
              if (chartFingerprint) {
                writeLastSavedChartFingerprint(chartFingerprint);
              }
              setMsg('Профиль и карта сохранены в облаке.');
            } else {
              setMsg('Профиль сохранён в облаке. Карта без изменений.');
            }
          } else {
            setMsg('Профиль сохранён в облаке.');
          }
        } else {
          setMsg('Профиль сохранён в облаке.');
        }
      } catch (e) {
        console.warn('Не удалось сохранить chart из localStorage:', e);
        setMsg('Профиль сохранён в облаке (ошибка сохранения карты).');
      }

      if (!fingerprint) {
        fingerprint = computeSnapshotFingerprint(stamped);
      }
      if (fingerprint) {
        writeLastSavedFingerprint(fingerprint);
      }
      if (navigateAfter) {
        navigateToChart();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMsg(`Ошибка при сохранении: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200"
        onClick={() => void saveProfileAndMaybeChart(false)}
        disabled={saving}
      >
        {saving ? 'Сохраняем...' : 'Сохранить анкету'}
      </button>
      <button
        className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200"
        onClick={() => void saveProfileAndMaybeChart(true)}
        disabled={saving}
      >
        {saving ? 'Сохраняем...' : 'Натальная карта'}
      </button>
      {msg ? <div className="text-sm text-gray-600">{msg}</div> : null}
    </div>
  );
}

function DoneButton({ navigate, getProfileSnapshot }: { navigate: (to: string) => void; getProfileSnapshot?: () => ProfileSnapshot | null }) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const setGlobalProfile = useProfile((state) => state.setProfile);

  async function handleDone() {
    setMsg(null);
    setSaving(true);
    try {
      let snapshot = getProfileSnapshot ? getProfileSnapshot() : null;
      if (!snapshot) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) throw new Error("Нет локального профиля для сохранения.");
        const parsed = JSON.parse(raw) as unknown;
        snapshot = extractProfileSnapshotFromRaw(parsed);
      }
      if (!snapshot) throw new Error("Не удалось собрать данные профиля.");

      // 1) Save locally and navigate immediately
      const stamped: ProfileSnapshot = { ...(snapshot ?? {}), updated_at: Date.now() };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile: stamped }));
        
        // Also update profile in saved chart data so Synastry page sees the changes
        const savedChartRaw = localStorage.getItem(SAVED_CHART_KEY);
        if (savedChartRaw) {
          try {
            const savedChartData = JSON.parse(savedChartRaw);
            savedChartData.profile = stamped;
            localStorage.setItem(SAVED_CHART_KEY, JSON.stringify(savedChartData));
          } catch (e) {
            console.warn("Failed to update profile in saved chart data:", e);
          }
        }
      } catch (e) {
        console.warn('Failed to persist local profile before navigation', e);
      }

      setGlobalProfile({
        firstName: stamped.personName ?? "",
        lastName: stamped.lastName ?? "",
        birth: stamped.birth,
        gender: stamped.gender,
        country: stamped.country,
        cityName: stamped.selectedCity,
        cityNameRu: stamped.cityNameRu ?? (stamped.selectedCity ? latinToRuName(stamped.selectedCity) : undefined),
        residenceCountry: stamped.residenceCountry,
        residenceCityName: stamped.residenceCityName,
        lat: typeof stamped.lat === "number" ? stamped.lat : undefined,
        lon: typeof stamped.lon === "number" ? stamped.lon : undefined,
      });

      // Get user id for navigation; if not logged in, still navigate to profile route guard
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (userId) {
        navigate(`/user/${userId}`);
      } else {
        navigate('/user/unknown');
      }

      // 2) Background cloud sync (fire-and-forget)
      void (async () => {
        try {
          if (!userId) return;
          let fingerprint = computeSnapshotFingerprint(stamped);
          const lastFingerprint = readLastSavedFingerprint();
          if (fingerprint && lastFingerprint && fingerprint === lastFingerprint) {
            return; // nothing changed
          }
          const payload = { id: userId, data: stamped };
          const { error: upsertErr } = await supabase.from('profiles').upsert(payload);
          if (!upsertErr && fingerprint) writeLastSavedFingerprint(fingerprint);

          // Try upload chart if local cache exists and changed
          try {
            const saved = localStorage.getItem(SAVED_CHART_KEY);
            if (saved) {
              const parsedSaved = JSON.parse(saved) as Record<string, JsonValue>;
              const chart = (parsedSaved.chart ?? null) as JsonValue | null;
              const meta = (parsedSaved.meta ?? null) as JsonValue | null;
              const chartFp = computeChartFingerprint(chart, meta);
              const lastChartFp = readLastSavedChartFingerprint();
              const shouldSaveChart = Boolean(chart && chartFp && chartFp !== lastChartFp);
              if (chart && shouldSaveChart) {
                const name = `${snapshot?.personName ?? 'chart'} ${new Date().toLocaleString()}`;
                await saveChart(userId, name, 'private', stamped, chart, meta ?? undefined);
                if (chartFp) writeLastSavedChartFingerprint(chartFp);
              }
            }
          } catch (e) {
            console.warn('Background chart save failed:', e);
          }
        } catch (e) {
          console.warn('Background profile save failed:', e);
        }
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMsg(`Ошибка при сохранении: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      className="px-18 py-8 rounded bg-blue-600 hover:bg-blue-700 text-white text-4xl font-bold shadow"
      onClick={handleDone}
      disabled={saving}
      style={{ marginTop: '-50px' }}
    >
      {saving ? 'Сохраняем...' : 'Готово'}
      {msg ? <span className="ml-4 text-xl font-normal">{msg}</span> : null}
    </button>
  );
}

const Questionnaire: React.FC = () => {
  const navigate = useNavigate();
  // Detect if we arrived from a file-loaded chart
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const arrivedFromFile = params.get('fromFile') === '1';

  type HeaderData = {
    name: string;
    last: string;
    birth: string;
    city: string;
    ascSign: string;
  };

  const [headerData, setHeaderData] = useState<HeaderData | null>(null);
  const loadSeqRef = useRef(0);

  // Load header data from cloud and localStorage
  // Функция загрузки данных анкеты и фото
  // Load header data from cloud and localStorage
  // �㭪�� ����㧪� ������ ������ � ��
  const loadProfileData = useCallback(async () => {
    const callId = ++loadSeqRef.current;
    try {
      // 1) Быстрый локальный прелоад из файла/кэша, чтобы избежать "старых" плейсхолдеров
      const localSnapshot = readStoredProfileSnapshot();
      if (localSnapshot) {
        const birthRaw = typeof localSnapshot.birth === "string" ? localSnapshot.birth : "";
        const birth = birthRaw ? birthRaw.replace("T", "; T") : "";
        const genericSnapshot = localSnapshot as Record<string, unknown>;
        const fallbackName = genericSnapshot.name;
        const fallbackSurname = genericSnapshot.surname;
        const fallbackCity = genericSnapshot.city;
        const fallbackCityRu = genericSnapshot.cityNameRu ?? genericSnapshot.city_ru;
        const nameCandidate =
          (typeof localSnapshot.personName === "string" && localSnapshot.personName) ||
          (typeof fallbackName === "string" ? fallbackName : "");
        const lastCandidate =
          (typeof localSnapshot.lastName === "string" && localSnapshot.lastName) ||
          (typeof fallbackSurname === "string" ? fallbackSurname : "");
        const cityCandidate =
          (typeof localSnapshot.cityNameRu === "string" && localSnapshot.cityNameRu) ||
          (typeof localSnapshot.selectedCity === "string" && localSnapshot.selectedCity) ||
          (typeof localSnapshot.cityQuery === "string" && localSnapshot.cityQuery) ||
          (typeof fallbackCityRu === "string" ? fallbackCityRu : (typeof fallbackCity === "string" ? fallbackCity : ""));
        let ascCandidate = typeof localSnapshot.ascSign === "string" ? localSnapshot.ascSign : "";
        if (!ascCandidate && isRecord(genericSnapshot.ascendant) && typeof genericSnapshot.ascendant.sign === "string") {
          const signCode = genericSnapshot.ascendant.sign;
          ascCandidate = SIGN_NAMES_RU[signCode] ?? signCode;
        }
        if (!ascCandidate) {
          const storedAsc = readStoredAscSign();
          if (storedAsc) ascCandidate = storedAsc;
        }

        if (callId !== loadSeqRef.current) {
          return;
        }
        setHeaderData({
          name: nameCandidate || "",
          last: lastCandidate || "",
          birth,
          city: cityCandidate || "",
          ascSign: ascCandidate || "",
        });
        setMainPhoto((typeof localSnapshot.mainPhoto === "string" ? localSnapshot.mainPhoto : null) ?? null);
        setGender(localSnapshot.gender === 'male' || localSnapshot.gender === 'female' ? localSnapshot.gender : "");
        setSmallPhotos(normalizeSmallPhotos(localSnapshot.smallPhotos));
        setTypeazh(typeof localSnapshot.typeazh === "string" ? localSnapshot.typeazh : "");
        setFamilyStatus(typeof localSnapshot.familyStatus === "string" ? localSnapshot.familyStatus : "");
        setAbout(typeof localSnapshot.about === "string" ? localSnapshot.about : "");
        setInterests(typeof localSnapshot.interests === "string" ? localSnapshot.interests : "");
        setCareer(typeof localSnapshot.career === "string" ? localSnapshot.career : "");
        setChildren(typeof localSnapshot.children === "string" ? localSnapshot.children : "");
        setResidenceCountry(
          typeof localSnapshot.residenceCountry === "string" && localSnapshot.residenceCountry
            ? localSnapshot.residenceCountry
            : "RU",
        );
        setResidenceCityName(
          typeof localSnapshot.residenceCityName === "string" ? localSnapshot.residenceCityName : "",
        );
      }

  // 2) Затем подтягиваем облако и мерджим
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id ?? null;
      setCurrentUserId(userId);

      // Load cloud snapshot
      let cloudSnapshot: ProfileSnapshot | null = null;
      if (userId) {
        const { data, error } = await supabase.from("profiles").select("data").eq("id", userId).single();
        if (error) {
          console.warn("Error loading profile from Supabase:", error);
        }
        cloudSnapshot = extractProfileSnapshotFromRaw(data?.data);
      }

      // Decide merge strategy
      const localId = personFingerprint(localSnapshot);
      const cloudId = personFingerprint(cloudSnapshot);
      let mergedSnapshot: ProfileSnapshot | null = null;
      if (localSnapshot && (arrivedFromFile || (cloudSnapshot && localId && cloudId && localId !== cloudId))) {
        // Если пришли из файла ИЛИ обнаружили другого человека в облаке — полностью доверяем локальным данным
        mergedSnapshot = localSnapshot;
        // Чистим флаг из URL, чтобы не повторялся на фокусах
        try {
          if (arrivedFromFile) {
            const url = new URL(window.location.href);
            url.searchParams.delete('fromFile');
            window.history.replaceState(null, '', url.toString());
          }
        } catch {}
      } else if (localSnapshot && cloudSnapshot) {
        // Один и тот же человек — локальные поля имеют приоритет
        mergedSnapshot = { ...cloudSnapshot, ...localSnapshot } as ProfileSnapshot;
      } else {
        mergedSnapshot = (localSnapshot || cloudSnapshot || null) as ProfileSnapshot | null;
      }

      if (mergedSnapshot) {
        const birthRaw = typeof mergedSnapshot.birth === "string" ? mergedSnapshot.birth : "";
        const birth = birthRaw ? birthRaw.replace("T", "; T") : "";
        const genericSnapshot = mergedSnapshot as Record<string, unknown>;
        const fallbackName = genericSnapshot.name;
        const fallbackSurname = genericSnapshot.surname;
        const fallbackCity = genericSnapshot.city;
        const fallbackCityRu = genericSnapshot.cityNameRu ?? genericSnapshot.city_ru;
        const nameCandidate =
          (typeof mergedSnapshot.personName === "string" && mergedSnapshot.personName) ||
          (typeof fallbackName === "string" ? fallbackName : "");
        const lastCandidate =
          (typeof mergedSnapshot.lastName === "string" && mergedSnapshot.lastName) ||
          (typeof fallbackSurname === "string" ? fallbackSurname : "");
        const cityCandidate =
          (typeof mergedSnapshot.cityNameRu === "string" && mergedSnapshot.cityNameRu) ||
          (typeof mergedSnapshot.selectedCity === "string" && mergedSnapshot.selectedCity) ||
          (typeof mergedSnapshot.cityQuery === "string" && mergedSnapshot.cityQuery) ||
          (typeof fallbackCityRu === "string" ? fallbackCityRu : (typeof fallbackCity === "string" ? fallbackCity : ""));
        let ascCandidate =
          typeof mergedSnapshot.ascSign === "string" ? mergedSnapshot.ascSign : "";
        if (!ascCandidate && isRecord(genericSnapshot.ascendant) && typeof genericSnapshot.ascendant.sign === "string") {
          const signCode = genericSnapshot.ascendant.sign;
          ascCandidate = SIGN_NAMES_RU[signCode] ?? signCode;
        }
        if (!ascCandidate) {
          const storedAsc = readStoredAscSign();
          if (storedAsc) ascCandidate = storedAsc;
        }

        if (callId !== loadSeqRef.current) {
          return;
        }
        setHeaderData({
          name: nameCandidate || "",
          last: lastCandidate || "",
          birth,
          city: cityCandidate || "",
          ascSign: ascCandidate || "",
        });
        setMainPhoto((typeof mergedSnapshot.mainPhoto === "string" ? mergedSnapshot.mainPhoto : null) ?? null);
        setGender(mergedSnapshot.gender === 'male' || mergedSnapshot.gender === 'female' ? mergedSnapshot.gender : "");
        setSmallPhotos(normalizeSmallPhotos(mergedSnapshot.smallPhotos));
        setTypeazh(typeof mergedSnapshot.typeazh === "string" ? mergedSnapshot.typeazh : "");
        setFamilyStatus(typeof mergedSnapshot.familyStatus === "string" ? mergedSnapshot.familyStatus : "");
        setAbout(typeof mergedSnapshot.about === "string" ? mergedSnapshot.about : "");
        setInterests(typeof mergedSnapshot.interests === "string" ? mergedSnapshot.interests : "");
        setCareer(typeof mergedSnapshot.career === "string" ? mergedSnapshot.career : "");
        setChildren(typeof mergedSnapshot.children === "string" ? mergedSnapshot.children : "");
        setResidenceCountry(
          typeof mergedSnapshot.residenceCountry === "string" && mergedSnapshot.residenceCountry
            ? mergedSnapshot.residenceCountry
            : "RU",
        );
        setResidenceCityName(
          typeof mergedSnapshot.residenceCityName === "string" ? mergedSnapshot.residenceCityName : "",
        );
        return;
      }

      // Если ничего не нашли ни локально, ни в облаке — обнуляем
      if (!localSnapshot && !cloudSnapshot) {
        if (callId !== loadSeqRef.current) {
          return;
        }
        setHeaderData(null);
        setMainPhoto(null);
        setGender("");
        setSmallPhotos([null, null]);
        setTypeazh("");
        setFamilyStatus("");
        setAbout("");
        setInterests("");
        setCareer("");
        setChildren("");
        setResidenceCountry("RU");
        setResidenceCityName("");
      }
    } catch (error) {
      console.warn("Error loading header:", error);
      if (callId !== loadSeqRef.current) {
        return;
      }
      setHeaderData(null);
    }
  }, [arrivedFromFile, loadSeqRef]);

  useEffect(() => {
    void loadProfileData();
    window.addEventListener('focus', loadProfileData);
    return () => {
      window.removeEventListener('focus', loadProfileData);
    };
  }, [loadProfileData]);

  // State for photos
  const [mainPhoto, setMainPhoto] = React.useState<string | null>(null);
  const [smallPhotos, setSmallPhotos] = React.useState<(string | null)[]>([null, null]);

  // State for form fields
  const [gender, setGender] = useState<"male" | "female" | "">("");
  const [typeazh, setTypeazh] = useState<string>("");
  const [familyStatus, setFamilyStatus] = useState<string>("");
  const [about, setAbout] = useState<string>("");
  const [interests, setInterests] = useState<string>("");
  const [career, setCareer] = useState<string>("");
  const [children, setChildren] = useState<string>("");
  const [residenceCountry, setResidenceCountry] = useState<string>("RU");
  const [residenceCityName, setResidenceCityName] = useState<string>("");
  const [residenceCountries, setResidenceCountries] = useState<string[]>(["RU"]);
  const [residenceCityOptions, setResidenceCityOptions] = useState<ResidenceCityOption[]>([]);
  const [residenceCitiesLoading, setResidenceCitiesLoading] = useState(false);
  const residenceCountriesLoadedRef = useRef(false);
  const residenceCityCacheRef = useRef<Map<string, ResidenceCityOption[]>>(new Map());

  // Load profile from cloud/localStorage on mount
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const persistFieldToLocal = useCallback((field: keyof ProfileSnapshot, value: JsonValue) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const base = raw ? (JSON.parse(raw) as Record<string, JsonValue>) : {};
      const profileRaw = base.profile;
      const profileObject = isRecord(profileRaw) ? profileRaw : {};
      const timestamp = Date.now();
      const updatedProfile = { ...profileObject, [field]: value, updated_at: timestamp } as Record<string, JsonValue>;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...base, profile: updatedProfile }));
      loadSeqRef.current += 1;
    } catch (storageError) {
      console.warn(`Failed to persist ${String(field)} to localStorage`, storageError);
    }
  }, [loadSeqRef]);

  const persistFieldToCloud = useCallback(
    async (field: keyof ProfileSnapshot, value: JsonValue) => {
      if (!currentUserId) return;
      try {
        const { data: profileRow } = await supabase.from('profiles').select('data').eq('id', currentUserId).single();
        const baseData = profileRow?.data;
        const baseObject = isRecord(baseData) ? baseData : {};
        await supabase.from('profiles').upsert({ id: currentUserId, data: { ...baseObject, [field]: value, updated_at: Date.now() } });
      } catch (error) {
        console.warn(`Failed to persist field ${String(field)} to Supabase`, error);
      }
    },
    [currentUserId],
  );

  const makeTextChangeHandler = useCallback(
    (field: keyof ProfileSnapshot, setter: (value: string) => void) =>
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { value } = event.target;
        setter(value);
        persistFieldToLocal(field, value);
      },
    [persistFieldToLocal],
  );

  const makeTextBlurHandler = useCallback(
    (field: keyof ProfileSnapshot, getter: () => string) => () => {
      void persistFieldToCloud(field, getter());
    },
    [persistFieldToCloud],
  );

  useEffect(() => {
    if (residenceCountriesLoadedRef.current) return;
    residenceCountriesLoadedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(publicAssetUrl("cities-by-country/index.json"), { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as CitiesIndexFile;
        const codes = Array.isArray(data?.countries)
          ? data.countries.map((entry) => entry.country.toUpperCase()).filter((code): code is string => Boolean(code))
          : [];
        if (!codes.includes(residenceCountry)) {
          codes.push(residenceCountry);
        }
        codes.sort((a, b) => countryNameRU(a).localeCompare(countryNameRU(b), "ru"));
        if (!cancelled) {
          setResidenceCountries(codes);
        }
      } catch (error) {
        console.warn("Failed to load countries index", error);
        if (!cancelled) {
          setResidenceCountries((prev) => (prev.includes(residenceCountry) ? prev : [...prev, residenceCountry]));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [residenceCountry]);

  useEffect(() => {
    let cancelled = false;
    const loadCities = async () => {
      setResidenceCitiesLoading(true);
      const cached = residenceCityCacheRef.current.get(residenceCountry);
      if (cached) {
        setResidenceCityOptions(cached);
        setResidenceCitiesLoading(false);
        return;
      }
      try {
        const response = await fetch(publicAssetUrl(`cities-by-country/${residenceCountry}.json`), { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as CityJsonItem[];
        const russianCities = residenceCountry === "RU" ? await getRussianCities().catch(() => null) : null;
        const mapped: ResidenceCityOption[] = data
          .filter((entry) => typeof entry.name === "string")
          .map((entry) => {
            const name = String(entry.name);
            const latValue = typeof entry.lat === "number" ? entry.lat : parseFloat(String(entry.lat));
            const lonValue = typeof entry.lon === "number" ? entry.lon : parseFloat(String(entry.lon));
            const ruFromFile =
              typeof entry.name_ru === "string" && entry.name_ru.trim()
                ? entry.name_ru.trim()
                : typeof entry.nameRu === "string" && entry.nameRu.trim()
                  ? entry.nameRu.trim()
                  : null;
            let nameRu = ruFromFile ?? latinToRuName(name);
            if (residenceCountry === "RU" && russianCities) {
              const match = findNearestRussianCity(latValue, lonValue, russianCities);
              if (match) {
                nameRu = match.name ?? nameRu;
              }
            }
            const id =
              entry.geonameid !== undefined
                ? String(entry.geonameid)
                : `${residenceCountry}:${name}:${entry.lat}:${entry.lon}`;
            return { id, name, nameRu };
          })
          .sort((a, b) => (a.nameRu || a.name).localeCompare(b.nameRu || b.name, "ru"));
        const deduped: ResidenceCityOption[] = [];
        const seen = new Set<string>();
        for (const option of mapped) {
          const key = (option.nameRu || option.name).trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(option);
        }
        residenceCityCacheRef.current.set(residenceCountry, deduped);
        if (!cancelled) {
          setResidenceCityOptions(deduped);
        }
      } catch (error) {
        console.warn("Failed to load residence cities", error);
        if (!cancelled) {
          setResidenceCityOptions([]);
        }
      } finally {
        if (!cancelled) {
          setResidenceCitiesLoading(false);
        }
      }
    };
    void loadCities();
    return () => {
      cancelled = true;
    };
  }, [residenceCountry]);

  const handleResidenceCountryChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      setResidenceCountry(value);
      persistFieldToLocal("residenceCountry", value);
      void persistFieldToCloud("residenceCountry", value);
    },
    [persistFieldToLocal, persistFieldToCloud],
  );

  const handleResidenceCityChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setResidenceCityName(value);
      persistFieldToLocal("residenceCityName", value);
    },
    [persistFieldToLocal],
  );

  const handleResidenceCityBlur = useCallback(() => {
    void persistFieldToCloud("residenceCityName", residenceCityName);
  }, [residenceCityName, persistFieldToCloud]);

  
  // Build a profile snapshot from current state and localStorage fallback
  const getProfileSnapshot = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const base = raw ? JSON.parse(raw) : {};
      const profileBase = base?.profile ?? base ?? {};
      const ascSign = headerData?.ascSign || profileBase.ascSign || '';
      return {
        ...profileBase,
        gender: gender || profileBase.gender,
        mainPhoto,
        smallPhotos,
        typeazh,
        familyStatus,
        about,
        interests,
        career,
        children,
        ascSign,
        residenceCountry: residenceCountry || profileBase.residenceCountry,
        residenceCityName: residenceCityName || profileBase.residenceCityName,
      };
    } catch {
      const ascSign = headerData?.ascSign || '';
      return {
        gender: gender || undefined,
        mainPhoto,
        smallPhotos,
        typeazh,
        familyStatus,
        about,
        interests,
        career,
        children,
        ascSign,
        residenceCountry,
        residenceCityName,
      };
    }
  }, [gender, mainPhoto, smallPhotos, typeazh, familyStatus, about, interests, career, children, residenceCountry, residenceCityName, headerData]);

  // ========== Image utilities ==========
  // Estimate bytes of a data URL without decoding
  const dataUrlBytes = (dataUrl: string): number => {
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    // Base64 size estimation
    return Math.floor((base64.length * 3) / 4);
  };

  // Compress image file to a data URL <= maxBytes (tries WEBP/JPEG, reduces quality and scales down if needed)
  async function compressImageToDataUrl(file: File, maxBytes = 300 * 1024): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });

      const originalW = img.naturalWidth || img.width;
      const originalH = img.naturalHeight || img.height;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D not supported');

      // Prefer WEBP, fallback to JPEG
      const tryFormats: Array<'image/webp' | 'image/jpeg'> = ['image/webp', 'image/jpeg'];
      let bestDataUrl = '';
      let bestSize = Infinity;

      for (const fmt of tryFormats) {
        let scale = 1.0;
        let quality = 0.92;
        // Try up to 10 iterations adjusting quality/scale
        for (let i = 0; i < 10; i++) {
          const w = Math.max(1, Math.round(originalW * scale));
          const h = Math.max(1, Math.round(originalH * scale));
          canvas.width = w;
          canvas.height = h;
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL(fmt, quality);
          const bytes = dataUrlBytes(dataUrl);
          if (bytes < bestSize) {
            bestDataUrl = dataUrl;
            bestSize = bytes;
          }
          if (bytes <= maxBytes) {
            return dataUrl;
          }
          if (quality > 0.55) {
            quality = Math.max(0.55, quality - 0.12);
          } else {
            // Reduce scale proportionally to how far we are from target
            const ratio = Math.min(0.9, Math.max(0.5, Math.sqrt(maxBytes / bytes)));
            scale = Math.max(0.3, scale * ratio * 0.98);
          }
        }
      }

      // If couldn't reach target, return best achieved
      return bestDataUrl;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Handlers with compression and delete actions
  const handleMainPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.currentTarget as HTMLInputElement | null;
    const file = inputEl?.files?.[0];
    if (!file) return;
    try {
      const result = await compressImageToDataUrl(file, 300 * 1024);
      if (typeof result !== 'string') return;
      setMainPhoto(result);
      persistFieldToLocal('mainPhoto', result);
      void persistFieldToCloud('mainPhoto', result);
    } catch (err) {
      console.warn('Failed to compress main photo:', err);
    } finally {
      // reset input value so same file can be re-selected (avoid React pooled event)
      try { if (inputEl) inputEl.value = ''; } catch {}
    }
  };

  const handleSmallPhoto = (idx: number) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.currentTarget as HTMLInputElement | null;
    const file = inputEl?.files?.[0];
    if (!file) return;
    try {
      const result = await compressImageToDataUrl(file, 300 * 1024);
      if (typeof result !== 'string') return;
      setSmallPhotos((arr) => {
        const normalized = normalizeSmallPhotos(arr);
        const next = [...normalized];
        next[idx] = result;
        persistFieldToLocal('smallPhotos', next);
        void persistFieldToCloud('smallPhotos', next);
        return next;
      });
    } catch (err) {
      console.warn('Failed to compress small photo:', err);
    } finally {
      try { if (inputEl) inputEl.value = ''; } catch {}
    }
  };

  const handleDeleteMainPhoto = (ev: React.MouseEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMainPhoto(null);
    persistFieldToLocal('mainPhoto', null);
    void persistFieldToCloud('mainPhoto', null);
  };

  const handleDeleteSmallPhoto = (idx: number) => (ev: React.MouseEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    setSmallPhotos((arr) => {
      const normalized = normalizeSmallPhotos(arr);
      const next = [...normalized];
      next[idx] = null;
      persistFieldToLocal('smallPhotos', next);
      void persistFieldToCloud('smallPhotos', next);
      return next;
    });
  };

  return (
    <div className="p-4">
      <div className="max-w-6xl mx-auto">
        <header className="mb-4 flex flex-col items-start gap-2">
          <div className="w-full flex justify-between items-center mb-2">
            <h2 className="text-3xl font-bold">{headerData ? `${headerData.name} ${headerData.last}` : 'Имя Фамилия'}</h2>
            <div className="flex flex-wrap gap-2 items-start">
              <button
                onClick={() => navigate("/app")}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Новая карта
              </button>
              <button
                onClick={() => navigate("/chart")}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Натальная карта
              </button>
              <button
                disabled
                className="px-3 py-1.5 bg-indigo-600 border border-indigo-300 rounded text-sm cursor-default"
              >
                Изменить анкету
              </button>
              <button
                onClick={async () => {
                  const { data: sessionData } = await supabase.auth.getSession();
                  const userId = sessionData?.session?.user?.id;
                  if (userId) navigate(`/user/${userId}`);
                }}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Профиль
              </button>
              <button
                onClick={() => navigate("/sinastry")}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Синастрия
              </button>
            </div>
          </div>
          <div className="text-base text-gray-700 font-normal">
            {headerData ? (
              <>
                Локальное время: {headerData.birth || '—'}<br />
                Восходящий знак: {headerData.ascSign || '—'}<br />
                {headerData.city ? <span>Место рождения: {headerData.city}</span> : <span>Место рождения: —</span>}
              </>
            ) : (
              <>Локальное время: —<br />Восходящий знак: —<br />Место рождения: —</>
            )}
          </div>
          <div className="mt-2 text-sm text-white/70">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="gender"
                  value="male"
                  checked={gender === 'male'}
                  onChange={() => {
                    setGender('male');
                    persistFieldToLocal('gender', 'male');
                    void persistFieldToCloud('gender', 'male');
                  }}
                  className="h-4 w-4 accent-white/80"
                />
                <span>Мужской</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="gender"
                  value="female"
                  checked={gender === 'female'}
                  onChange={() => {
                    setGender('female');
                    persistFieldToLocal('gender', 'female');
                    void persistFieldToCloud('gender', 'female');
                  }}
                  className="h-4 w-4 accent-white/80"
                />
                <span>Женский</span>
              </label>
            </div>
          </div>
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 border border-white/20 text-sm mt-3"
            onClick={() => {
              let snapshot = getProfileSnapshot ? getProfileSnapshot() : null;
              if (!snapshot) {
                snapshot = readStoredProfileSnapshot();
              }

              let parsedChart: unknown = null;
              try {
                const chartRaw = localStorage.getItem(SAVED_CHART_KEY);
                if (chartRaw) {
                  parsedChart = JSON.parse(chartRaw) as unknown;
                }
              } catch (parseError) {
                console.warn("Failed to parse saved chart for export", parseError);
              }

              const { chart: exportChart, meta: exportMeta, screenshot, profile: fallbackProfile } =
                extractChartPayloadForExport(parsedChart);

              if (!snapshot && fallbackProfile) {
                snapshot = fallbackProfile;
              }

              const payload: Record<string, unknown> = {};
              if (snapshot) payload.profile = snapshot;
              if (exportChart) payload.chart = exportChart;
              if (exportMeta) payload.meta = exportMeta;
              if (!exportChart && screenshot) payload.screenshot = screenshot;
              if (!payload.profile && fallbackProfile) payload.profile = fallbackProfile;
              if (Object.keys(payload).length === 0) {
                payload.profile = snapshot ?? fallbackProfile ?? {};
              }

              const data = JSON.stringify(payload, null, 2);
              const blob = new Blob([data], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "synastry_profile.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Сохранить в файл
          </button>
        </header>
        <div className="flex" style={{ marginTop: '20px' }}>
          {/* Photos column */}
          <section className="flex flex-col items-start">
            <label className="relative bg-white/5 border border-white/10 hover:border-blue-400 rounded-md flex items-center justify-center cursor-pointer" style={{ width: 200, height: 266 }}>
              {mainPhoto ? <img src={mainPhoto} alt="Главное фото" className="object-cover w-full h-full rounded-md" /> : <div className="text-gray-400">Главное фото<br/>(200x266)</div>}
              <input type="file" accept="image/*" className="hidden" onChange={handleMainPhoto} />
              {mainPhoto && (
                <button
                  title="удалить"
                  aria-label="удалить"
                  className="absolute top-1 right-1 w-6 h-6 rounded-md bg-black/60 hover:bg-red-600 text-white flex items-center justify-center border border-white/30"
                  onClick={handleDeleteMainPhoto}
                >
                  ×
                </button>
              )}
            </label>
            <div className="flex gap-3 mt-3">
              {[0,1].map((sidx) => (
                <a key={sidx} href={currentUserId ? `/photo/${currentUserId}/${sidx+1}` : '#'} target="_blank" rel="noreferrer" className="block">
                  <label className="relative w-[150px] h-[150px] bg-white/5 border border-white/10 hover:border-blue-400 rounded-md flex items-center justify-center cursor-pointer">
                    {smallPhotos[sidx] ? <img src={smallPhotos[sidx] as string} alt="Фото" className="object-cover w-full h-full rounded-md" /> : '+'}
                    <input type="file" accept="image/*" className="hidden" onChange={handleSmallPhoto(sidx)} />
                    {smallPhotos[sidx] && (
                      <button
                        title="удалить"
                        aria-label="удалить"
                        className="absolute top-1 right-1 w-5 h-5 rounded-md bg-black/60 hover:bg-red-600 text-white flex items-center justify-center border border-white/30"
                        onClick={handleDeleteSmallPhoto(sidx)}
                      >
                        ×
                      </button>
                    )}
                  </label>
                </a>
              ))}
            </div>
            <div className="mt-3 text-sm text-gray-600">Загрузите главное фото и два дополнительных.</div>
          </section>
          {/* Fields column */}
          <section className="flex-1 flex justify-center items-start pl-8" style={{ marginLeft: '-50px' }}>
            <div className="w-[500px]">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-white">Типаж</label>
                <input value={typeazh}
                  onChange={makeTextChangeHandler("typeazh", setTypeazh)}
                  onBlur={makeTextBlurHandler("typeazh", () => typeazh)}
                  className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white">Семейное положение</label>
                <input value={familyStatus}
                  onChange={makeTextChangeHandler("familyStatus", setFamilyStatus)}
                  onBlur={makeTextBlurHandler("familyStatus", () => familyStatus)}
                  className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-white">О себе</label>
                <textarea value={about}
                  onChange={makeTextChangeHandler("about", setAbout)}
                  onBlur={makeTextBlurHandler("about", () => about)}
                  className="mt-1 block w-full rounded px-2 py-1 h-32 bg-black/30 border border-white/10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white">Интересы</label>
                <input value={interests}
                  onChange={makeTextChangeHandler("interests", setInterests)}
                  onBlur={makeTextBlurHandler("interests", () => interests)}
                  className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white">Карьера, образование</label>
                <input value={career}
                  onChange={makeTextChangeHandler("career", setCareer)}
                  onBlur={makeTextBlurHandler("career", () => career)}
                  className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white">Дети</label>
                <input value={children}
                  onChange={makeTextChangeHandler("children", setChildren)}
                  onBlur={makeTextBlurHandler("children", () => children)}
                  className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                />
              </div>
            <div className="col-span-2 rounded border border-white/10 p-3 bg-black/10">
              <label className="block text-sm font-medium text-white mb-2">Место жительства</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-white/60">Страна</span>
                  <select
                    value={residenceCountry}
                    onChange={handleResidenceCountryChange}
                    className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                  >
                    {residenceCountries.map((code) => (
                      <option key={code} value={code}>
                        {countryNameRU(code)} ({code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="text-xs text-white/60">Город</span>
                  <input
                    list="residence-city-options"
                    value={residenceCityName}
                    onChange={handleResidenceCityChange}
                    onBlur={handleResidenceCityBlur}
                    placeholder="Начните ввод..."
                    className="mt-1 block w-full rounded px-2 py-1 bg-black/30 border border-white/10"
                  />
                  <datalist id="residence-city-options">
                    {residenceCityOptions.map((city) => (
                      <option key={city.id} value={city.nameRu || city.name}>
                        {city.nameRu || city.name}
                      </option>
                    ))}
                  </datalist>
                  {residenceCitiesLoading ? (
                    <div className="text-xs text-white/60 mt-1">Загрузка списка городов...</div>
                  ) : null}
                </div>
              </div>
            </div>
            </div>
            </div>
          </section>
        </div>
        {/* Кнопка Готово внизу анкеты */}
        <div className="mt-8 flex justify-end relative" style={{ marginBottom: '50px' }}>
          <DoneButton navigate={navigate} getProfileSnapshot={getProfileSnapshot} />
        </div>
      </div>
    </div>
  );
};



export default Questionnaire;





