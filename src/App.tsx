import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import moment from "moment-timezone";
import tzLookup from "tz-lookup";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { useProfile } from "./store/profile";
import { readProfileFromStorage, writeProfileToStorage } from "./utils/profileStorage";
import { clearSavedChart, writeSavedChart } from "./utils/savedChartStorage";
import { latinToRuApprox, latinToRuName, norm, ruToLat } from "./utils/transliterate";
import { getRussianCities, findNearestRussianCity, type RussianCity } from "./utils/russianCitiesClient";
import {
  PROFILE_SNAPSHOT_STORAGE_KEY as STORAGE_KEY,
  LAST_SAVED_PROFILE_FINGERPRINT_KEY as LAST_SAVED_FINGERPRINT_KEY,
  LAST_SAVED_CHART_FINGERPRINT_KEY,
} from "./constants/storageKeys";
import { BUTTON_SECONDARY } from "./constants/buttonPalette";

const SUPPORT_EMAIL = "pilot.vt@mail.ru";
const SUPPORT_TELEGRAM = "@PilotVT";

type CityWorld = {
  id: string;
  name: string;
  nameRu: string;
  lat: number;
  lon: number;
  country: string;
  searchKey: string;
  nameNorm: string;
  nameRuNorm: string;
  nameTranslit: string;
  nameApprox: string;
  regionRu?: string;
  population?: number;
};

type CitiesJsonItem = {
  country: string;
  name: string;
  lat: number;
  lon: number;
  geonameid?: string | number;
  nameRu?: string;
  name_ru?: string;
  city_ru?: string;
  ruName?: string;
  region_ru?: string;
  population?: number;
};

type CitiesIndexFile = {
  countries: Array<{ country: string; count: number }>;
};

type ProfileSnapshot = {
  personName: string;
  lastName: string;
  birth: string;
  gender: "male" | "female";
  country: string;
  cityQuery: string;
  selectedCity: string;
  cityId?: string;
  cityNameRu?: string;
  residenceCountry?: string;
  residenceCityName?: string;
  manual: boolean;
  lat: number;
  lon: number;
  enableTzCorrection: boolean;
  tzCorrectionHours: number;
  dstManual: boolean;
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

function isProfileLike(value: unknown): value is Partial<ProfileSnapshot> {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSmallPhotosArray(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) return [null, null];
  const normalized = value.slice(0, 2).map((item) => (typeof item === "string" ? item : null));
  while (normalized.length < 2) {
    normalized.push(null);
  }
  return normalized;
}

function readStoredProfileSnapshot(expectedOwnerId?: string | null): Partial<ProfileSnapshot> | null {
  try {
    const stored = readProfileFromStorage<Partial<ProfileSnapshot> | Record<string, unknown>>(STORAGE_KEY);
    if (!stored) return null;
    const { profile, ownerId } = stored;
    if (expectedOwnerId !== undefined) {
      const expected = expectedOwnerId ?? null;
      if (ownerId !== undefined) {
        if (ownerId !== expected) return null;
      } else if (expected) {
        return null;
      }
    }
    if (profile && isProfileLike(profile)) {
      if (!profile.cityNameRu && typeof profile.selectedCity === 'string') {
        profile.cityNameRu = latinToRuName(profile.selectedCity);
      }
      return profile;
    }

    // Legacy formats: support flat payloads with firstName/lastName etc
    if (isRecord(profile)) {
      const legacy = profile as Record<string, unknown>;
      const personName = typeof legacy.personName === 'string'
        ? legacy.personName
        : typeof legacy.firstName === 'string'
          ? legacy.firstName
          : typeof legacy.name === 'string'
            ? legacy.name
            : undefined;
      const lastName = typeof legacy.lastName === 'string'
        ? legacy.lastName
        : typeof legacy.surname === 'string'
          ? legacy.surname
          : undefined;

      const snapshot: Partial<ProfileSnapshot> = {};
      if (personName !== undefined) snapshot.personName = personName;
      if (lastName !== undefined) snapshot.lastName = lastName;
      if (typeof legacy.birth === 'string') snapshot.birth = legacy.birth;
      if (legacy.gender === 'male' || legacy.gender === 'female') snapshot.gender = legacy.gender;
      if (typeof legacy.country === 'string') snapshot.country = legacy.country;
      if (typeof legacy.cityQuery === 'string') snapshot.cityQuery = legacy.cityQuery;
      if (typeof legacy.selectedCity === 'string') snapshot.selectedCity = legacy.selectedCity;
      if (typeof legacy.cityId === 'string') snapshot.cityId = legacy.cityId;
      if (typeof legacy.cityNameRu === 'string') snapshot.cityNameRu = legacy.cityNameRu;
      if (typeof legacy.residenceCountry === 'string') snapshot.residenceCountry = legacy.residenceCountry;
      if (typeof legacy.residenceCityName === 'string') snapshot.residenceCityName = legacy.residenceCityName;
      if (typeof legacy.lat === 'number' && Number.isFinite(legacy.lat)) snapshot.lat = legacy.lat;
      if (typeof legacy.lon === 'number' && Number.isFinite(legacy.lon)) snapshot.lon = legacy.lon;
      if (typeof legacy.manual === 'boolean') snapshot.manual = legacy.manual;
      if (typeof legacy.enableTzCorrection === 'boolean') snapshot.enableTzCorrection = legacy.enableTzCorrection;
      if (typeof legacy.tzCorrectionHours === 'number' && Number.isFinite(legacy.tzCorrectionHours)) {
        snapshot.tzCorrectionHours = legacy.tzCorrectionHours;
      }
      if (typeof legacy.dstManual === 'boolean') snapshot.dstManual = legacy.dstManual;
      if (typeof legacy.dstManualOverride === 'boolean') snapshot.dstManualOverride = legacy.dstManualOverride;
      if (typeof legacy.mainPhoto === 'string') snapshot.mainPhoto = legacy.mainPhoto;
      if (Array.isArray(legacy.smallPhotos)) snapshot.smallPhotos = legacy.smallPhotos as (string | null)[];
      if (typeof legacy.typeazh === 'string') snapshot.typeazh = legacy.typeazh;
      if (typeof legacy.familyStatus === 'string') snapshot.familyStatus = legacy.familyStatus;
      if (typeof legacy.about === 'string') snapshot.about = legacy.about;
      if (typeof legacy.interests === 'string') snapshot.interests = legacy.interests;
      if (typeof legacy.career === 'string') snapshot.career = legacy.career;
      if (typeof legacy.children === 'string') snapshot.children = legacy.children;

      if (Object.keys(snapshot).length > 0) {
        if (!snapshot.cityNameRu && typeof snapshot.selectedCity === 'string') {
          snapshot.cityNameRu = latinToRuName(snapshot.selectedCity);
        }
        return snapshot;
      }
    }
  } catch (error) {
    console.warn('Failed to read stored profile snapshot', error);
  }
  return null;
}

function clearStoredChartCache() {
  try {
    clearSavedChart();
    localStorage.removeItem(LAST_SAVED_FINGERPRINT_KEY);
    localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
  } catch (error) {
    console.warn("Failed to clear chart cache", error);
  }
}

// Build a person identity fingerprint using core fields. If these change, it's a different person.
function personFingerprint(p: Partial<ProfileSnapshot> | null | undefined): string {
  if (!p) return "";
  const name = (p.personName ?? "").trim().toLowerCase();
  const last = (p.lastName ?? "").trim().toLowerCase();
  const birth = (p.birth ?? "").trim();
  const city = (p.selectedCity ?? p.cityQuery ?? "").trim().toLowerCase();
  const cityId = typeof p?.cityId === 'string' ? p.cityId.trim() : '';
  const lat = typeof p.lat === 'number' ? p.lat.toFixed(4) : '';
  const lon = typeof p.lon === 'number' ? p.lon.toFixed(4) : '';
  return [name, last, birth, cityId || city, lat, lon].join('|');
}

function clampLat(value: number) {
  return Math.max(-90, Math.min(90, value));
}

function clampLon(value: number) {
  return Math.max(-180, Math.min(180, value));
}

const regionNames = new Intl.DisplayNames(["ru"], { type: "region" });

function countryNameRU(code: string) {
  const c = String(code || "").toUpperCase();
  // Guard against invalid codes that crash Intl.DisplayNames.of
  if (!/^[A-Z]{2,3}$/.test(c)) return c || "—";
  try {
    return regionNames.of(c) ?? c;
  } catch {
    return c;
  }
}

function pad2(n: number) {
  return (n < 10 ? "0" : "") + n;
}

function minutesToUTCsign(min: number) {
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${pad2(h)}:${pad2(m)}`;
}

const MIN_SUPPORTED_TZ_YEAR = 1920;
const getDisplayOffsetMinutes = (tm: moment.Moment | null, tz: string): number => {
  if (!tm) return 0;
  if (tm.year() >= MIN_SUPPORTED_TZ_YEAR) return tm.utcOffset();
  const zone = moment.tz.zone(tz);
  if (!zone) return tm.utcOffset();
  const refTs = Date.UTC(
    MIN_SUPPORTED_TZ_YEAR,
    tm.month(),
    tm.date(),
    tm.hour(),
    tm.minute(),
  );
  // moment.tz.zone offsets use the opposite sign (minutes west of UTC), so flip to match moment.utcOffset
  return -zone.utcOffset(refTs);
};

function combineDateTime(datePart: string, timePart: string) {
  const cleanDate = datePart.trim();
  const cleanTime = timePart.trim();
  if (!cleanDate) return "";
  const normalizedTime = cleanTime ? cleanTime.padStart(5, "0") : "00:00";
  return `${cleanDate}T${normalizedTime}`;
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

export default function App() {
  // ...existing code...
  // ...existing code...

  // ...existing code...
  const [cityInputFocused, setCityInputFocused] = useState(false);
  const [personName, setPersonName] = useState("");
  const [lastName, setLastName] = useState("");
  const [birth, setBirth] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");


  // ...existing code...
  // Восстановление профиля из snapshot
  const applyProfileObject = useCallback((snapshot: Partial<ProfileSnapshot>) => {
    if (!snapshot) return;
    const source = snapshot;
    if (typeof source.personName === "string") setPersonName(source.personName);
    if (typeof source.lastName === "string") setLastName(source.lastName);
    if (typeof source.birth === "string") setBirth(source.birth);
    if (source.gender === "male" || source.gender === "female") setGender(source.gender);
    if (typeof source.country === "string") setCountry(source.country);
    if (typeof source.cityQuery === "string") setCityQuery(source.cityQuery);
    if (typeof source.selectedCity === "string") setSelectedCity(source.selectedCity);
    if (typeof source.cityId === "string") setSelectedCityId(source.cityId);
    if (typeof source.lat === "number" && Number.isFinite(source.lat)) setLat(source.lat);
    if (typeof source.lon === "number" && Number.isFinite(source.lon)) setLon(source.lon);
    if (typeof source.manual === "boolean") setManual(source.manual);
    if (typeof source.enableTzCorrection === "boolean") setEnableTzCorrection(source.enableTzCorrection);
    if (typeof source.tzCorrectionHours === "number" && Number.isFinite(source.tzCorrectionHours)) setTzCorrectionHours(source.tzCorrectionHours);
    if (typeof source.dstManual === "boolean") setDstManual(source.dstManual);
    if (typeof source.dstManualOverride === "boolean") setDstManualOverride(source.dstManualOverride);
  }, []);

  const [country, setCountry] = useState("RU");
  const [cityQuery, setCityQuery] = useState("");
  const [selectedCity, setSelectedCity] = useState("");
  const [selectedCityId, setSelectedCityId] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState(55.7558);
  const [lon, setLon] = useState(37.6173);
  const [allCities, setAllCities] = useState<CityWorld[]>([]);
  const [countries, setCountries] = useState<string[]>(["RU"]);
  const cityCacheRef = useRef<Map<string, CityWorld[]>>(new Map());
  const citiesIndexLoadedRef = useRef(false);
  const selectedCityData = useMemo(() => {
    if (selectedCityId) {
  const direct = allCities.find((c: CityWorld) => c.id === selectedCityId);
      if (direct) return direct;
    }
    if (selectedCity) {
  const byName = allCities.find((c: CityWorld) => c.name === selectedCity);
      if (byName) return byName;
  const byRuName = allCities.find((c: CityWorld) => c.nameRu === selectedCity);
      if (byRuName) return byRuName;
    }
    return null;
  }, [allCities, selectedCityId, selectedCity]);
  const [fuzzyCities, setFuzzyCities] = useState<CityWorld[]>([]);

  const [enableTzCorrection, setEnableTzCorrection] = useState(false);
  const [tzCorrectionHours, setTzCorrectionHours] = useState(0);
  const [dstManual, setDstManual] = useState(false);
  const [dstManualOverride, setDstManualOverride] = useState(false);

  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  // Отключаем облако: всегда считаем, что данные загружены
  const [cloudHydrated, setCloudHydrated] = useState(true);
  // Явная инициализация всех стейтов при монтировании
  useEffect(() => {
    setPersonName("");
    setLastName("");
  // setCityQuery("");
  // setSelectedCity("");
  // setSelectedCityId(null);
  // setLat(0);
  // setLon(0);
  // setCountry("");
  // setBirth("");
  // setGender("male");
    setEnableTzCorrection(false);
    setTzCorrectionHours(0);
    setDstManual(false);
    setDstManualOverride(false);
    setCityInputFocused(false);
    // ... другие поля, если есть
  }, []);
  const [buildingChart, setBuildingChart] = useState(false);
  const [buildError, setBuildError] = useState("");
  const [licenseStatus, setLicenseStatus] = useState<ElectronLicenseStatus | null>(null);
  const [cloudLicenseKey, setCloudLicenseKey] = useState<string | null>(null);
  const remoteLicenseAppliedRef = useRef(false);
  const lastLicenseUserRef = useRef<string | null>(null);
  const { setProfile, loadFromLocal, logout } = useProfile();
  const sessionUserId = session?.user?.id ?? null;
  const navigate = useNavigate();
  // User explicitly changed country in UI; suppress auto-reset to RU/Moscow
  const userChangedCountryRef = useRef(false);
  const cityAutoPrefillDoneRef = useRef(false);
  const userEditedCityRef = useRef(false);
  // If user returns with manual=true but no selected city, re-enable typing automatically
  useEffect(() => {
    if (manual && !selectedCityId) {
      setManual(false);
    }
  }, [manual, selectedCityId]);
  useEffect(() => {
    loadFromLocal();
  }, [loadFromLocal]);

  const syncProfileFromSnapshot = useCallback((snapshot: Record<string, unknown>) => {
    const sanitized = snapshot;
    setProfile({
      firstName: typeof sanitized.personName === 'string' ? sanitized.personName : undefined,
      lastName: typeof sanitized.lastName === 'string' ? sanitized.lastName : undefined,
      birth: typeof sanitized.birth === 'string' ? sanitized.birth : undefined,
      gender: sanitized.gender === 'male' || sanitized.gender === 'female' ? sanitized.gender : undefined,
      country: typeof sanitized.country === 'string' ? sanitized.country : undefined,
      cityName: typeof sanitized.selectedCity === 'string' ? sanitized.selectedCity : undefined,
      cityNameRu: typeof sanitized.cityNameRu === 'string'
        ? sanitized.cityNameRu
        : (typeof sanitized.cityQuery === 'string' ? sanitized.cityQuery : undefined),
      residenceCountry: typeof sanitized.residenceCountry === 'string' ? sanitized.residenceCountry : undefined,
      residenceCityName: typeof sanitized.residenceCityName === 'string' ? sanitized.residenceCityName : undefined,
      cityId: typeof sanitized.cityId === 'string' ? sanitized.cityId : undefined,
      lat: typeof sanitized.lat === 'number' ? sanitized.lat : undefined,
      lon: typeof sanitized.lon === 'number' ? sanitized.lon : undefined,
      ascSign: typeof sanitized.ascSign === 'string' ? sanitized.ascSign : undefined,
    });
  }, [setProfile]);

  const previousAccountRef = useRef<string | null>(null);
  useEffect(() => {
    const userId = session?.user?.id ?? null;
    const prev = previousAccountRef.current;
    if (prev === userId) return;
    previousAccountRef.current = userId;

    // Если сменился пользователь, очищаем кэш профиля и savedChart
    if (prev && prev !== userId) {
      clearStoredChartCache();
      logout();
      try {
        localStorage.removeItem(STORAGE_KEY);
        clearSavedChart();
        localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
        localStorage.removeItem(LAST_SAVED_FINGERPRINT_KEY);
      } catch (storageError) {
        console.warn('Failed to clear cached profile after account switch', storageError);
      }
    }

    if (!userId) {
      loadFromLocal();
      return;
    }

    (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('data')
          .eq('id', userId)
          .maybeSingle();
        if (error) {
          if (!error.code || (error.code !== 'PGRST116' && error.code !== '42P01')) {
            console.warn('Не удалось загрузить профиль из облака:', error.message ?? error);
          }
          loadFromLocal();
          return;
        }
        if (isRecord(data?.data)) {
          syncProfileFromSnapshot(data.data as Record<string, unknown>);
        } else {
          loadFromLocal();
        }
      } catch (err) {
        console.warn('Не удалось синхронизировать профиль из облака', err);
        loadFromLocal();
      }
    })();
  }, [session?.user?.id, loadFromLocal, logout, syncProfileFromSnapshot]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = window.electronAPI?.license;
    if (!api) return;

    api.getStatus()
      ?.then((status) => {
        if (status) setLicenseStatus(status);
      })
      .catch((error) => {
        console.warn("Не удалось получить статус лицензии", error);
      });

    const unsubscribeStatus = api.onStatus?.((status) => {
      setLicenseStatus(status);
    });


    return () => {
      unsubscribeStatus?.();
    };
  }, []);
  // Синхронизируем форму с глобальным профилем для snapshot и Supabase.
useEffect(() => {
  // защита: не затираем профиль пустыми значениями при старте
  const nothingFilled =
    !personName && !lastName && !birth && !selectedCity && lat === 55.7558 && lon === 37.6173;
  if (nothingFilled) return;

  const cityNameEnForProfile = selectedCityData?.name || (selectedCity || undefined);
  const cityNameRuForProfile = selectedCityData?.nameRu || (cityQuery || undefined);
  setProfile({
    firstName: personName || undefined,
    lastName:  lastName  || undefined,
    birth:     birth     || undefined, // 'YYYY-MM-DDTHH:mm'
    gender,
    country,
    cityName: cityNameEnForProfile,
    cityNameRu: cityNameRuForProfile,
    cityId: selectedCityData?.id,
    lat,
    lon,
  });
}, [
  personName,
  lastName,
  birth,
  gender,
  country,
  selectedCity,
  selectedCityData,
  cityQuery,
  lat,
  lon,
  setProfile,
]);

  // Load countries index once on mount
  useEffect(() => {
    if (citiesIndexLoadedRef.current) return;
    citiesIndexLoadedRef.current = true;

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(publicAssetUrl("cities-by-country/index.json"), {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as CitiesIndexFile;
        if (cancelled) return;

        const codes = Array.isArray(data?.countries)
          ? data.countries
              .map((entry) => entry.country.toUpperCase())
              .filter((code): code is string => Boolean(code))
          : [];

        if (!codes.includes(country)) {
          codes.push(country);
        }

  codes.sort((a: string, b: string) => countryNameRU(a).localeCompare(countryNameRU(b), "ru"));
        setCountries(codes);
      } catch (error) {
        console.error("Не удалось загрузить список стран для городов", error);
        setCountries((prev: string[]) => {
          if (prev.includes(country)) return prev;
          const next = [...prev, country];
          next.sort((a: string, b: string) => countryNameRU(a).localeCompare(countryNameRU(b), "ru"));
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [country]);

  useEffect(() => {
    let cancelled = false;

    const cached = cityCacheRef.current.get(country);
    if (cached) {
      setAllCities(cached);
      return;
    }

  const controller = new AbortController();
    setAllCities([]);

    (async () => {
      try {
  const response = await fetch(publicAssetUrl(`cities-by-country/${country}.json`), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as CitiesJsonItem[];
        if (cancelled) return;

        const russianCities = country === "RU" ? await getRussianCities().catch(() => null) : null;

        const prepared: CityWorld[] = [];
        for (const c of data) {
          if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
          const name = String(c.name);
          const latValue = typeof c.lat === "number" ? c.lat : parseFloat(String(c.lat));
          const lonValue = typeof c.lon === "number" ? c.lon : parseFloat(String(c.lon));
          const countryCode = String(c.country).toUpperCase();
          const rawId = c.geonameid !== undefined ? String(c.geonameid) : `${countryCode}:${name}:${latValue}:${lonValue}`;
          let matchedRussian: RussianCity | null = null;
          if (country === "RU" && russianCities) {
            matchedRussian = findNearestRussianCity(latValue, lonValue, russianCities);
          }

          let nameRu =
            typeof c.name_ru === "string" && c.name_ru.trim()
              ? c.name_ru.trim()
              : typeof c.nameRu === "string" && c.nameRu.trim()
                ? c.nameRu.trim()
                : latinToRuName(name);
          let regionRu = typeof c.region_ru === "string" ? c.region_ru : undefined;

          if (matchedRussian) {
            nameRu = matchedRussian.name || nameRu;
            regionRu = matchedRussian.subject ?? regionRu;
          }

          const normalizedName = norm(name);
          const transliterated = ruToLat(name);
          const approx = latinToRuApprox(normalizedName);
          const nameRuNorm = norm(nameRu);
          const transliteratedRu = ruToLat(nameRu);
          const approxRu = latinToRuApprox(nameRuNorm);
          const parts = new Set(
            [normalizedName, transliterated, approx, nameRuNorm, transliteratedRu, approxRu].filter(Boolean),
          );

          const populationFromMatch =
            matchedRussian && typeof matchedRussian.population === "number"
              ? matchedRussian.population
              : typeof c.population === "number"
                ? c.population
                : undefined;

          prepared.push({
            id: rawId,
            name,
            nameRu,
            lat: latValue,
            lon: lonValue,
            country: countryCode,
            searchKey: Array.from(parts).join("|"),
            nameNorm: normalizedName,
            nameRuNorm,
            nameTranslit: transliterated,
            nameApprox: approx,
            regionRu,
            population: populationFromMatch,
          });
        }

        const resultList =
          country === "RU"
            ? Array.from(
                prepared.reduce((map, city) => {
                  const key = (city.nameRu || city.name).trim().toLowerCase();
                  const existing = map.get(key);
                  if (!existing) {
                    map.set(key, city);
                    return map;
                  }
                  const currentPop = typeof city.population === "number" ? city.population : 0;
                  const existingPop = typeof existing.population === "number" ? existing.population : 0;
                  if (currentPop > existingPop) {
                    map.set(key, city);
                  }
                  return map;
                }, new Map<string, CityWorld>()).values(),
              )
            : prepared;

        cityCacheRef.current.set(country, resultList);
        if (!cancelled) {
          setAllCities(resultList);
        }
      } catch (error) {
        if (cancelled || (error as Error)?.name === "AbortError") return;
        console.error(`Не удалось загрузить города для страны ${country}`, error);
        setAllCities([]);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [country]);

  // Убираем авто-подстановку города (Москва) — город должен выбирать только пользователь.
  useEffect(() => {
    if (allCities.length === 0) return;
    // Если ранее в кэше был город/ручной режим — просто отмечаем, что автоподстановки быть не должно
    try {
      const rawLocal = localStorage.getItem(STORAGE_KEY);
      if (rawLocal) {
        const snap = JSON.parse(rawLocal) as Partial<ProfileSnapshot> | null;
        if (snap) {
          if (
            (typeof snap.selectedCity === "string" && snap.selectedCity) ||
            (typeof snap.cityQuery === "string" && snap.cityQuery) ||
            (typeof snap.manual === "boolean" && snap.manual)
          ) {
            cityAutoPrefillDoneRef.current = true;
          }
        }
      }
    } catch (error) {
      console.warn("Failed to parse cached profile snapshot", error);
    }
  }, [allCities]);

  const citiesOfCountry = allCities;

  const filteredCities = useMemo(() => {
    const query = cityQuery.trim();
    if (!query) {
  return citiesOfCountry.slice().sort((a: CityWorld, b: CityWorld) => a.nameRu.localeCompare(b.nameRu, "ru"));
    }

    const normalized = norm(query);
    const translit = ruToLat(query);
    const approx = latinToRuApprox(normalized);
    const referenceLength = normalized ? normalized.length : query.length;

    const scored = citiesOfCountry
  .map((city: CityWorld) => {
        let bestScore = Number.POSITIVE_INFINITY;
        const scores: number[] = [];

        if (normalized) {
          if (city.nameNorm === normalized) scores.push(0);
          if (city.nameNorm.startsWith(normalized)) scores.push(1);
          if (city.nameNorm.includes(normalized)) scores.push(3);
          if (city.nameRuNorm === normalized) scores.push(0.2);
          if (city.nameRuNorm.startsWith(normalized)) scores.push(1.2);
          if (city.nameRuNorm.includes(normalized)) scores.push(3.2);
        }
        if (translit) {
          if (city.nameTranslit === translit) scores.push(0.5);
          if (city.nameTranslit.startsWith(translit)) scores.push(2);
          if (city.nameTranslit.includes(translit)) scores.push(4);
        }
        if (approx) {
          if (city.nameApprox === approx) scores.push(1.5);
          if (city.nameApprox.startsWith(approx)) scores.push(2.5);
          if (city.nameApprox.includes(approx)) scores.push(4.5);
        }

        if (!normalized && !translit && !approx) {
          scores.push(10);
        }

        if (scores.length === 0) {
          return null;
        }

        bestScore = Math.min(...scores);

        if (normalized && city.nameNorm.startsWith(normalized)) {
          const tailLength = Math.max(0, city.nameNorm.length - normalized.length);
          bestScore -= Math.min(0.1, tailLength * 0.01);
        }

        const lengthPenalty = Math.abs(city.name.length - referenceLength) * 0.002;
        let finalScore = bestScore + lengthPenalty;
        finalScore -= city.name.length * 0.0005;
        if (/[ '\u2019-]/.test(city.name)) {
          finalScore += 0.05;
        }

        return { city, score: finalScore };
      })
  .filter((entry: { city: CityWorld; score: number } | null): entry is { city: CityWorld; score: number } => entry !== null)
      .sort((a: { city: CityWorld; score: number }, b: { city: CityWorld; score: number }) => {
        if (a.score !== b.score) return a.score - b.score;
        if (a.city.name.length !== b.city.name.length) return a.city.name.length - b.city.name.length;
        return a.city.name.localeCompare(b.city.name, "ru");
      });

  return scored.slice(0, 200).map((entry: { city: CityWorld; score: number }) => entry.city);
  }, [citiesOfCountry, cityQuery]);

  // Fallback: if nothing matched and the user typed in Cyrillic, try a fuzzy
  // transliteration match (helps when dataset uses Latin names like "Moscow"
  // but user typed "москва"). Instead of overwriting the query, maintain a
  // dedicated list so the user can choose from the suggestions manually.
  useEffect(() => {
    const q = cityQuery.trim();
    if (!q) {
      setFuzzyCities([]);
      return;
    }
    // detect Cyrillic letters
    if (!/[\u0400-\u04FF]/.test(q) || filteredCities.length > 0) {
      setFuzzyCities([]);
      return;
    }

    // simple Levenshtein distance implementation
    function levenshtein(a: string, b: string) {
      const m = a.length;
      const n = b.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
      }
      return dp[m][n];
    }

    const translitQuery = ruToLat(q);
    const candidates = citiesOfCountry
  .map((c: CityWorld) => {
        const base = c.nameRu ? ruToLat(c.nameRu) : c.nameTranslit || ruToLat(c.name);
        return { city: c, dist: levenshtein(base, translitQuery) };
      })
  .filter((c: { city: CityWorld; dist: number }) => c.dist <= 4)
  .sort((a: { city: CityWorld; dist: number }, b: { city: CityWorld; dist: number }) => a.dist - b.dist)
      .slice(0, 50)
  .map((c: { city: CityWorld; dist: number }) => c.city);

    setFuzzyCities(candidates);
  }, [cityQuery, citiesOfCountry, filteredCities]);

  const citySuggestions = filteredCities.length > 0 ? filteredCities : fuzzyCities;

  const resolveCityFromQuery = useCallback(
    (query: string): CityWorld | null => {
      const trimmed = query.trim();
      if (!trimmed) return null;
      const normalized = norm(trimmed);
      const translit = ruToLat(trimmed);
      const approx = latinToRuApprox(normalized);
      const lower = trimmed.toLowerCase();
      const loose = translit.replace(/y/g, "i");

      const dataset = citiesOfCountry.length > 0 ? citiesOfCountry : allCities;

      return (
  dataset.find((city: CityWorld) => {
          if (city.nameNorm === normalized) return true;
          if (city.nameRuNorm === normalized) return true;
          if (city.nameTranslit === translit) return true;
          if (city.nameApprox === approx) return true;
          if (city.nameTranslit.replace(/y/g, "i") === loose) return true;
          if (city.name.toLowerCase() === lower) return true;
          if (city.nameRu.toLowerCase() === lower) return true;
          if (city.searchKey.includes(normalized)) return true;
          if (city.searchKey.includes(translit)) return true;
          if (approx && city.searchKey.includes(approx)) return true;
          return false;
        }) ?? null
      );
    },
    [citiesOfCountry, allCities],
  );

  useEffect(() => {
    if (manual) return;
    if (!selectedCityData) return;

    const latMatches = Math.abs(lat - selectedCityData.lat) < 1e-6;
    const lonMatches = Math.abs(lon - selectedCityData.lon) < 1e-6;

    cityAutoPrefillDoneRef.current = true;
    userEditedCityRef.current = false;

    if (selectedCity !== selectedCityData.name) {
      setSelectedCity(selectedCityData.name);
    }
    if (selectedCityId !== selectedCityData.id) {
      setSelectedCityId(selectedCityData.id);
    }
    if (cityQuery !== selectedCityData.nameRu) {
      setCityQuery(selectedCityData.nameRu);
    }
    if (!latMatches) {
      setLat(selectedCityData.lat);
    }
    if (!lonMatches) {
      setLon(selectedCityData.lon);
    }
  }, [manual, selectedCityData, selectedCity, selectedCityId, cityQuery, lat, lon]);

  useEffect(() => {
    if (!manual) return;
    setSelectedCity("");
    setSelectedCityId(null);
  }, [manual]);

  const ianaTz = useMemo(() => {
    try {
      return tzLookup(lat, lon);
    } catch {
      return "UTC";
    }
  }, [lat, lon]);

  const birthMoment = useMemo(() => {
    if (!birth) return null;
    return moment.tz(birth, "YYYY-MM-DDTHH:mm", ianaTz);
  }, [birth, ianaTz]);

  const offsetMinAtBirth = birthMoment ? getDisplayOffsetMinutes(birthMoment, ianaTz) : 0;
  const dstAtBirth = birthMoment ? (birthMoment.year() >= MIN_SUPPORTED_TZ_YEAR ? birthMoment.isDST() : false) : false;
  const offsetStrAtBirth = minutesToUTCsign(offsetMinAtBirth);
  const autoDstKey = `${birthMoment ? birthMoment.format("YYYY-MM-DDTHH:mm") : "none"}|${ianaTz}`;
  const prevAutoDstKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevAutoDstKeyRef.current !== null && prevAutoDstKeyRef.current !== autoDstKey) {
      setDstManualOverride(false);
    }
    prevAutoDstKeyRef.current = autoDstKey;
  }, [autoDstKey]);

  useEffect(() => {
    if (!dstManualOverride && dstManual !== dstAtBirth) {
      setDstManual(dstAtBirth);
    }
  }, [dstAtBirth, dstManualOverride, dstManual]);

  // ОТКЛЮЧЕНО: восстановление профиля из snapshot
  // const applyProfileObject = useCallback((snapshot: Partial<ProfileSnapshot>) => {
  //   ...existing code...
  // }, [...]);

  const ageText = useMemo(() => {
    if (!birth) return "";
    const now = moment();
    const b = moment(birth, "YYYY-MM-DDTHH:mm");
    const years = now.diff(b, "years");
    const months = now.diff(b.add(years, "years"), "months");
    return `${years} лет ${months} мес`;
  }, [birth]);

  const licenseBlocked = false;
  const licenseOwner = licenseStatus?.licenseOwner ?? null;

  useEffect(() => {
    let unsub: { unsubscribe?: () => void } | null = null;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        setSession(data.session ?? null);
      } catch (err) {
        console.error("Не удалось получить текущую сессию:", err);
      } finally {
        setSessionReady(true);
      }

  const sub = supabase.auth.onAuthStateChange((_evt: AuthChangeEvent, sess: Session | null) => {
    setSession(sess ?? null);
  });
      unsub = sub?.data?.subscription ?? null;
    })();

    return () => {
      try {
        unsub?.unsubscribe?.();
      } catch (cleanupError) {
        console.warn("Не удалось корректно отписаться от auth подписки", cleanupError);
      }
    };
  }, []);

  useEffect(() => {
    if (sessionReady && !session?.user) {
      navigate("/", { replace: true });
    }
  }, [sessionReady, session?.user, navigate]);

  useEffect(() => {
    const currentId = session?.user?.id ?? null;
    if (lastLicenseUserRef.current !== currentId) {
      lastLicenseUserRef.current = currentId;
      setCloudLicenseKey(null);
      remoteLicenseAppliedRef.current = false;
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) return;

    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase
          .from('user_licenses')
          .select('license_key')
          .eq('user_id', session.user.id)
          .maybeSingle();

        if (cancelled) return;

        if (error) {
          // 42P01 — relation does not exist; treat as not configured
          if (error.code && error.code !== '42P01') {
            console.warn('Не удалось получить лицензию из Supabase:', error.message ?? error);
          }
          return;
        }

        const key = typeof data?.license_key === 'string' ? data.license_key.trim() : '';
        if (key && key !== cloudLicenseKey) {
          setCloudLicenseKey(key);
          remoteLicenseAppliedRef.current = false;
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Ошибка загрузки лицензии из Supabase', error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, cloudLicenseKey]);

  useEffect(() => {
    if (!sessionUserId) {
      setCloudHydrated(false);
      return;
    }

    let cancelled = false;

    (async () => {
      const userId = sessionUserId;
      const { data, error } = await supabase.from("profiles").select("data").eq("id", userId).single();

      if (cancelled) return;

      if (!error && data?.data) {
        const rawRemote = data.data;
        let remoteLicenseKey: string | null = null;
        let remoteSnapshot: Partial<ProfileSnapshot> | null = null;

        if (isRecord(rawRemote)) {
          if (typeof rawRemote.licenseKey === "string") {
            const keyCandidate = rawRemote.licenseKey.trim();
            if (keyCandidate) {
              remoteLicenseKey = keyCandidate;
            }
          }
          const sanitized = { ...rawRemote } as Record<string, unknown>;
          delete sanitized.licenseKey;
          if (isProfileLike(sanitized)) {
            remoteSnapshot = sanitized as Partial<ProfileSnapshot>;
          }
        } else if (isProfileLike(rawRemote)) {
          remoteSnapshot = rawRemote;
        }

        if (remoteLicenseKey && remoteLicenseKey !== cloudLicenseKey) {
          setCloudLicenseKey(remoteLicenseKey);
          remoteLicenseAppliedRef.current = false;
        }

        if (remoteSnapshot) {
          // Temporarily disable auto-hydration from cloud to avoid overriding user selection
          // applyProfileObject(mergedSnapshot);
        }
      } else if (error?.code === "PGRST116") {
        const payload = { id: userId, data: buildProfileObjectRef.current() };
        await supabase.from("profiles").upsert(payload);
      } else if (error) {
        console.error("Ошибка загрузки профиля из облака:", error);
      }

      setCloudHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionUserId, cloudLicenseKey]);

  useEffect(() => {
    if (!cloudLicenseKey) return;
    if (remoteLicenseAppliedRef.current) return;
  if (!session?.user?.email || !session?.user?.id) return;
  if (!licenseStatus?.identityEmail) return;
    if (typeof window === "undefined") return;

    const api = window.electronAPI?.license;
    if (!api?.activate) return;

    let cancelled = false;

    (async () => {
      try {
        const result = await api.activate(cloudLicenseKey);
        if (cancelled) return;
        if (result?.success) {
          remoteLicenseAppliedRef.current = true;
        } else if (result?.message) {
          console.warn("Удалённый ключ не прошёл проверку:", result.message);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("Ошибка при активации ключа из Supabase", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cloudLicenseKey, session?.user?.email, session?.user?.id, licenseStatus?.identityEmail]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!licenseStatus?.licensed) return;
    if (!session?.user?.id) return;

    const api = window.electronAPI?.license;
    if (!api?.getStoredKey) return;

    let cancelled = false;

    (async () => {
      try {
        const storedKey = await api.getStoredKey();
        if (!storedKey) return;
        if (cloudLicenseKey && cloudLicenseKey === storedKey) {
          remoteLicenseAppliedRef.current = true;
          return;
        }

        const { error } = await supabase
          .from('user_licenses')
          .upsert({
            user_id: session.user.id,
            license_key: storedKey,
            owner_email: session.user.email ?? null,
          }, { onConflict: 'user_id' });
        if (error) {
          if (error.code === '42P01') {
            console.warn('Таблица user_licenses отсутствует в Supabase. Создайте её для синхронизации лицензий.');
          } else if (error.code === '42703') {
            console.warn('В таблице user_licenses отсутствует колонка owner_email. Добавьте её (TEXT) или обновите запрос.');
          } else if (error.code) {
            throw error;
          } else {
            throw error;
          }
        }
        if (cancelled) return;
        setCloudLicenseKey(storedKey);
        remoteLicenseAppliedRef.current = true;
      } catch (error) {
        console.error("Не удалось сохранить лицензионный ключ в Supabase", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [licenseStatus?.licensed, session?.user?.id, session?.user?.email, cloudLicenseKey]);

  const buildProfileObject = useCallback((): ProfileSnapshot => {
    const base: ProfileSnapshot = {
      personName,
      lastName,
      birth,
      gender,
      country,
      cityQuery,
      selectedCity,
  cityId: selectedCityData?.id ?? selectedCityId ?? undefined,
  cityNameRu: selectedCityData?.nameRu ?? (cityQuery || undefined),
      manual,
      lat,
      lon,
      enableTzCorrection,
      tzCorrectionHours,
      dstManual,
      dstManualOverride,
      updated_at: Date.now(),
    };
    
    const existing = readStoredProfileSnapshot(sessionUserId ?? undefined);
    
    // Check if person identity changed — if yes, do NOT copy photos/bio from existing
    const currentId = personFingerprint(base);
    const existingId = personFingerprint(existing);
    const samePersonIdentity = currentId && existingId && currentId === existingId;
    
    if (existing && samePersonIdentity) {
      // Same person - merge photos/bio from existing
      if (Object.prototype.hasOwnProperty.call(existing, 'mainPhoto')) {
        base.mainPhoto = typeof existing.mainPhoto === 'string' ? existing.mainPhoto : null;
      }
      if (Object.prototype.hasOwnProperty.call(existing, 'smallPhotos')) {
        base.smallPhotos = normalizeSmallPhotosArray(existing.smallPhotos);
      }
      if (typeof existing.typeazh === 'string') base.typeazh = existing.typeazh;
      if (typeof existing.familyStatus === 'string') base.familyStatus = existing.familyStatus;
      if (typeof existing.about === 'string') base.about = existing.about;
      if (typeof existing.interests === 'string') base.interests = existing.interests;
      if (typeof existing.career === 'string') base.career = existing.career;
      if (typeof existing.children === 'string') base.children = existing.children;
    } else {
      // Different person (or no existing) - explicitly null photos/bio
      base.mainPhoto = null;
      base.smallPhotos = [null, null];
      base.typeazh = "";
      base.familyStatus = "";
      base.about = "";
      base.interests = "";
      base.career = "";
      base.children = "";
    }

    base.residenceCountry = undefined;
    base.residenceCityName = undefined;

    // normalize and return profile object
    if (!Array.isArray(base.smallPhotos)) {
      base.smallPhotos = [null, null];
    }
    if (base.smallPhotos.length < 2) {
      base.smallPhotos = normalizeSmallPhotosArray(base.smallPhotos);
    }
    if (base.mainPhoto === undefined) base.mainPhoto = null;
    return base;
  }, [
    personName,
    lastName,
    birth,
    gender,
    country,
    cityQuery,
    selectedCity,
    selectedCityId,
    selectedCityData,
    manual,
    lat,
    lon,
    enableTzCorrection,
    tzCorrectionHours,
    dstManual,
    dstManualOverride,
    sessionUserId,
  ]);

  // Build chart handler (restored header and locals)
  const buildProfileObjectRef = useRef(buildProfileObject);
  useEffect(() => { buildProfileObjectRef.current = buildProfileObject; }, [buildProfileObject]);

  // Save profile snapshot to cloud (Supabase)
  async function saveProfileToCloud(profileOverride?: ProfileSnapshot) {
    if (!session?.user?.id) throw new Error("Нет пользователя.");
    const rawPayload = profileOverride ?? buildProfileObject();
    const payload = { id: session.user.id, data: rawPayload };
    const { error } = await supabase.from("profiles").upsert(payload);
    if (error) throw error;
    setCloudHydrated(true);
  }
    async function handleBuildChart() {
      const fallbackMessage = "Не удалось построить карту.";
      setBuildError("");
      if (!session?.user?.id) {
        navigate("/", { replace: true });
        return;
      }
      let profileToPersist: ProfileSnapshot | null = null;

    // REMOVED: auto-resolve city from query text - this caused unwanted city substitutions.
    // City coords must ONLY come from explicit user selection (handled in handleBuildChart).
    // Дополнительно: если город не выбран (нет selectedCityId) — НЕ трогаем lat/lon.
    // Не перезатираем координаты, если пользователь редактирует поле города.
    if (!manual) {
      let match = (selectedCityData && selectedCityId === selectedCityData.id) ? selectedCityData : null;
      if (!match) {
        match = resolveCityFromQuery(cityQuery);
      }
      if (!match) {
        setBuildError('Город не выбран из списка. Выберите город из подсказок или введите точнее.');
        return;
      }
      const baseProfile = buildProfileObject();
      profileToPersist = {
        ...baseProfile,
        selectedCity: match.name,
        cityId: match.id,
        cityQuery: match.nameRu,
        cityNameRu: match.nameRu,
        lat: match.lat,
        lon: match.lon,
      };
      // Синхронизируем состояние формы с подтверждённым городом
      if (selectedCity !== match.name) setSelectedCity(match.name);
      if (selectedCityId !== match.id) setSelectedCityId(match.id);
      if (cityQuery !== match.nameRu) setCityQuery(match.nameRu);
      if (Math.abs(lat - match.lat) >= 1e-6) setLat(match.lat);
      if (Math.abs(lon - match.lon) >= 1e-6) setLon(match.lon);
    } else {
      profileToPersist = buildProfileObject();
    }

    const finalProfile = profileToPersist ?? buildProfileObject();

    try {
      setBuildingChart(true);
      // Ensure current form data is persisted in STORAGE_KEY before building
      try {
        writeProfileToStorage(STORAGE_KEY, finalProfile, sessionUserId ?? null, false);
      } catch (storageError) {
        console.warn('Failed to update profile snapshot before build', storageError);
      }
      await saveProfileToCloud(finalProfile);
      // Remove any cached saved chart so ChartPage will recalculate from profile
      try { 
        clearSavedChart();
        localStorage.removeItem(LAST_SAVED_FINGERPRINT_KEY);
        localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
      } catch { /* ignore */ }
      navigate("/chart?forceRefresh=1");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBuildError(message || fallbackMessage);
    } finally {
      setBuildingChart(false);
    }
  }

  const handleLogout = async () => {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error('Ошибка выхода из учётной записи:', err);
  } finally {
    navigate('/', { replace: true });
  }
};

if (!sessionReady) {
  return (
    <div className='min-h-screen flex items-center justify-center bg-slate-950 text-white'>
      Загрузка...
    </div>
  );
}
// end App component


  const FORM_MAX_WIDTH = 860;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-4 py-8" style={{ maxWidth: FORM_MAX_WIDTH }}>
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Новая карта</h1>
            <p className="text-sm text-white/70">
              Заполните имя, фамилию и дату рождения для расчёта зоны.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button
              type="button"
              onClick={handleLogout}
              className={`${BUTTON_SECONDARY} px-3 py-1 text-xs`}
            >
              Выйти
            </button>
            <button
              type="button"
              className={`${BUTTON_SECONDARY} px-3 py-1 text-xs`}
              onClick={() => {
                const id = session?.user?.id;
                if (id) navigate(`/user/${id}`);
                else navigate('/user/unknown');
              }}
            >
              Профиль
            </button>
            <button
              type="button"
              className={`${BUTTON_SECONDARY} px-3 py-1 text-xs`}
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json,application/json";
                input.onchange = () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = async (ev) => {
                    try {
                      const raw = ev.target?.result ?? null;
                      if (typeof raw !== 'string') throw new Error('Invalid file content');
                      const data = JSON.parse(raw);
                      const activeUserId = sessionUserId ?? (await (async () => {
                        try {
                          const { data: sessionData } = await supabase.auth.getSession();
                          return sessionData?.session?.user?.id ?? null;
                        } catch (authErr) {
                          console.warn('Не удалось получить сессию перед открытием файла', authErr);
                          return null;
                        }
                      })());
                      if (!activeUserId) {
                        alert('Не удалось определить текущего пользователя. Перезайдите и повторите попытку.');
                        return;
                      }

                      // If file contains a complete saved chart (chart + meta), open ChartPage from file
                      const looksLikeChart = !!(data && data.chart && data.meta && Array.isArray(data.chart.planets) && data.chart.ascendant);

                      if (looksLikeChart) {
                        clearStoredChartCache();
                        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
                        writeSavedChart(data, activeUserId, {
                          meta: { source: 'file', updatedAt: Date.now(), fingerprint: null },
                        });
                        navigate('/chart?fromFile=1');
                        return;
                      }

                      // If file looks like a profile snapshot, save into the input storage and go to /app
                      try {
                        const profilePayload = data.profile ?? data;
                        clearStoredChartCache();
                        writeProfileToStorage(STORAGE_KEY, profilePayload, activeUserId, false);
                        applyProfileObject(profilePayload);
                        navigate('/app', { replace: true });
                        return;
                      } catch (innerErr) {
                        console.warn('Failed to save profile snapshot to storage', innerErr);
                      }
  // После входа сразу открывать профиль, если он есть в облаке

                      // Fallback: still save raw into saved chart key and open ChartPage
                      clearStoredChartCache();
                      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
                        writeSavedChart(data, activeUserId, {
                          meta: { source: 'file', updatedAt: Date.now(), fingerprint: null },
                        });
                      navigate('/chart?fromFile=1');
                    } catch (error) {
                      console.warn('Failed to load chart file', error);
                      alert('Ошибка чтения файла');
                    }
                  };
                  reader.readAsText(file);
                };
                input.click();
              }}
            >
              Открыть
            </button>
          </div>
        </header>

        <main
          className="synastry-preview rounded-2xl bg-[#f9e0bbf2] backdrop-blur p-6 md:p-8 border border-white/10 shadow-lg w-full"
          style={{ maxWidth: FORM_MAX_WIDTH, margin: '0 auto' }}
        >
          <div className="rounded-xl border border-white/10 bg-transparent p-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-sm mb-1 font-semibold text-white">Имя</label>
                <input
                  type="text"
                  className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                  placeholder="Например: Иван"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm mb-1 font-semibold text-white">Фамилия</label>
                <input
                  type="text"
                  className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                  placeholder="Например: Петров"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm mb-1 text-white/70">Дата и время рождения</label>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="date"
                    className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                    value={birth ? birth.split("T")[0] : ""}
                    onChange={(e) => {
                      const timePart = birth ? birth.split("T")[1]?.slice(0, 5) ?? "" : "";
                      setBirth(combineDateTime(e.target.value, timePart));
                    }}
                    inputMode="numeric"
                  />
                  <input
                    type="time"
                    className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                    value={birth ? birth.split("T")[1]?.slice(0, 5) ?? "" : ""}
                    onChange={(e) => {
                      const datePart = birth ? birth.split("T")[0] : "";
                      setBirth(combineDateTime(datePart, e.target.value));
                    }}
                    inputMode="numeric"
                  />
                  <span className="text-xs text-white/60">Можно печатать цифрами или выбрать в календаре.</span>
                </div>
              </div>
            </div>

            <div className="mt-3 text-sm text-white/70">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="gender"
                    value="male"
                    checked={gender === "male"}
                    onChange={() => setGender("male")}
                    className="h-4 w-4 accent-white/80"
                  />
                  <span>Мужской</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="gender"
                    value="female"
                    checked={gender === "female"}
                    onChange={() => setGender("female")}
                    className="h-4 w-4 accent-white/80"
                  />
                  <span>Женский</span>
                </label>
              </div>
              <div className="mt-2">
                {personName && birth ? (
                  <>— {personName}{lastName ? ` ${lastName}` : ""}, возраст: <b className="text-white">{ageText}</b></>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-transparent p-4">
            <label className="block text-sm mb-2 text-white/70">Страна</label>
            <select
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
              value={country}
              onChange={(e) => {
                userChangedCountryRef.current = true;
                userEditedCityRef.current = true;
                cityAutoPrefillDoneRef.current = true;
                setCountry(e.target.value);
                setCityQuery("");
                setSelectedCity("");
                setSelectedCityId(null);
              }}
            >
              {countries.map((code: string) => (
                <option key={code} value={code}>
                  {countryNameRU(code)} ({code})
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-transparent p-4">
            <label className="block text-sm mb-2 text-white/70">Поиск города</label>
            <div style={{ position: "relative" }}>
              <input
                type="text"
                placeholder="Например, Омск / Omsk"
                className="mb-2 w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                value={cityQuery}
                onChange={(e) => {
                  userEditedCityRef.current = true;
                  setCityQuery(e.target.value);
                  setSelectedCity("");
                  setSelectedCityId(null);
                }}
                autoComplete="off"
                onFocus={() => setCityInputFocused(true)}
                onBlur={() => setTimeout(() => setCityInputFocused(false), 150)}
              />
              {!manual && cityInputFocused && cityQuery && citySuggestions.length > 0 && (
                <ul
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: "100%",
                    zIndex: 100,
                    background: "#f8fafc", // светло-серый фон
                    color: "#222", // тёмный шрифт
                    border: "1px solid rgba(0,0,0,0.08)",
                    borderRadius: "0.75rem",
                    marginTop: "0.25rem",
                    maxHeight: "12rem",
                    overflowY: "auto",
                  }}
                  className="autocomplete-list text-sm shadow-lg"
                >
                  {citySuggestions.map((c: CityWorld) => (
                    <li
                      key={`${c.id}`}
                      className="px-3 py-2 cursor-pointer hover:bg-blue-700"
                      onMouseDown={() => {
                        cityAutoPrefillDoneRef.current = true;
                        userEditedCityRef.current = false;
                        setSelectedCity(c.name);
                        setSelectedCityId(c.id);
                        setCityQuery(c.nameRu);
                        setLat(c.lat);
                        setLon(c.lon);
                        setCityInputFocused(false);
                      }}
                    >
                      <span className="font-medium text-sm text-slate-900">{c.nameRu}</span>
                      {country !== "RU" && c.nameRu !== c.name && (
                        <span className="ml-1 text-xs text-slate-500">({c.name})</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border border-white/10 bg-transparent p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                      <label className="block text-sm mb-1 text-white/70">Широта (lat)</label>
                  <input
                    type="number"
                    step="0.000001"
                      className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                    value={lat}
                    onChange={(e) => setLat(clampLat(parseFloat(e.target.value)))}
                    // Поле всегда активно
                  />
                </div>
                <div>
                      <label className="block text-sm mb-1 text-white/70">Долгота (lon)</label>
                  <input
                    type="number"
                    step="0.000001"
                      className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                    value={lon}
                    onChange={(e) => setLon(clampLon(parseFloat(e.target.value)))}
                    // Поле всегда активно
                  />
                </div>
              </div>

              <div className="mt-3 text-sm text-white/80">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-xs">IANA: {ianaTz}</span>
                  {birth && (
                    <span className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-xs">
                      На момент рождения: {offsetStrAtBirth} {dstAtBirth ? "(DST)" : "(без DST)"}
                    </span>
                  )}
                  {birthMoment && birthMoment.year() < MIN_SUPPORTED_TZ_YEAR && (
                    <span className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                      Исторические зоны до {MIN_SUPPORTED_TZ_YEAR} имеют дробные смещения; отображаем ближайшее актуальное значение.
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  id="enableCorr"
                  type="checkbox"
                  checked={enableTzCorrection}
                  onChange={(e) => setEnableTzCorrection(e.target.checked)}
                  className="h-4 w-4 accent-white/80"
                />
                <label htmlFor="enableCorr" className="text-sm text-white/80">
                  Включить ручную коррекцию
                </label>
                <input
                  type="number"
                  step="1"
                  min={-12}
                  max={14}
                  className="w-24 rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-sm outline-none disabled:opacity-50"
                  value={tzCorrectionHours}
                  onChange={(e) => setTzCorrectionHours(parseInt(e.target.value || "0", 10))}
                  disabled={!enableTzCorrection}
                />
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-white/80"
                    checked={dstManual}
                    onChange={(e) => {
                      setDstManualOverride(true);
                      setDstManual(e.target.checked);
                    }}
                    disabled={!enableTzCorrection}
                  />
                  Принуд. DST +1ч
                </label>
                <span className="text-xs text-white/60 w-full">
                  DST выставляется автоматически по истории тайм-зоны. Снимите галочку, если в этот период переход не применялся.
                </span>
              </div>
            </div>
              <div className="rounded-xl border border-white/10 bg-transparent p-4 flex flex-wrap items-start justify-center gap-4">
              <div className="flex-1 min-w-[200px] flex flex-col items-center gap-3">
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} inline-flex items-center justify-center rounded-2xl px-6 py-3 text-base shadow-lg transition disabled:opacity-50`}
                  style={{ fontWeight: 800 }}
                  onClick={handleBuildChart}
                  disabled={buildingChart || !cloudHydrated}
                >
                  {buildingChart ? "Сохраняем…" : "Построить натальную карту"}
                </button>
                <span className="text-xs text-white/60 text-center md:text-left">
                  Кнопка сохранит профиль и откроет расчёт натальной карты.
                </span>
                {buildError && (
                  <div className="text-xs text-red-400 text-center md:text-left">{buildError}</div>
                )}
              </div>
            </div>
          </div>
        </main>
        {licenseStatus?.licensed && (
          <div className="fixed bottom-4 right-4 z-[60] rounded-xl border border-emerald-400/40 bg-emerald-500/20 px-4 py-3 text-xs text-emerald-100 shadow-lg">
            Лицензия активна{licenseOwner ? ` — ${licenseOwner}` : ""}. Спасибо за поддержку!
          </div>
        )}
        {licenseBlocked && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-6 text-center text-white">
            <div className="max-w-md space-y-4">
              <h2 className="text-2xl font-semibold">Пробный период завершён</h2>
              <p className="text-sm text-white/80">
                Чтобы продолжить работу, введите лицензионный ключ, который вы получите после покупки. Меню «Справка → Купить» доступно в верхней панели.
              </p>
              {licenseStatus?.message && (
                <p className="text-sm text-red-200/80">{licenseStatus?.message}</p>
              )}
              <div className="space-y-2 text-sm text-white/70">
                <div>Контакты разработчика: {SUPPORT_EMAIL}</div>
                <div>Telegram: {SUPPORT_TELEGRAM}</div>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/30"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      const api = window.electronAPI?.license;
                      api?.requestPrompt?.();
                    }
                  }}
                >
                  Ввести ключ
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-white/30 px-4 py-2 text-xs text-white/70 hover:bg-white/10"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      window.location.href = `mailto:${SUPPORT_EMAIL}`;
                    }
                  }}
                >
                  Написать разработчику
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
 

