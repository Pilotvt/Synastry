/**
 * Преобразует Profile в ProfileSnapshot для ChartPage
 */
export function profileToSnapshot(profile: Profile): any {
  return {
    personName: profile.firstName,
    lastName: profile.lastName,
    birth: profile.birth,
    gender: profile.gender,
    country: profile.country,
    selectedCity: profile.cityName,
    cityQuery: profile.cityNameRu ?? profile.cityName,
    cityNameRu: profile.cityNameRu ?? profile.cityName,
    residenceCountry: profile.residenceCountry,
    residenceCityName: profile.residenceCityName,
    cityId: profile.cityId,
    lat: typeof profile.lat === 'number' ? profile.lat : 0,
    lon: typeof profile.lon === 'number' ? profile.lon : 0,
    ascSign: profile.ascSign,
    updated_at: profile.updatedAt,
    // остальные поля при необходимости
  };
}
import { create } from "zustand";

export type Profile = {
  id?: string;
  email?: string;
  firstName: string;
  lastName: string;
  birth?: string;          // 'YYYY-MM-DDTHH:mm'
  gender?: 'male' | 'female';
  country?: string;        // 'RU' и т.п.
  cityName?: string;       // 'Omsk'
  cityNameRu?: string;     // 'Омск'
  residenceCountry?: string;
  residenceCityName?: string;
  cityId?: string;
  lat?: number;
  lon?: number;
  ascSign?: string;        // Восходящий знак
  updatedAt: number;
};

type State = {
  profile: Profile;
  setProfile: (patch: Partial<Profile>) => void;
  loadFromLocal: () => void;
  logout: () => void;
};

const STORAGE_KEY = "syn_ui_profile_v2";

export const useProfile = create<State>((set, get) => ({
  profile: { firstName: "", lastName: "", updatedAt: 0 },

  setProfile: (patch) => {
    const next = { ...get().profile, ...patch, updatedAt: Date.now() };
    set({ profile: next });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  },

  loadFromLocal: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      set({ profile: JSON.parse(raw) });
    } catch {}
  },

  logout: () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    set({ profile: { firstName: "", lastName: "", updatedAt: 0 } });
  },
}));

// синхронизация между вкладками
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try { (useProfile as any).setState({ profile: JSON.parse(e.newValue) }); } catch {}
    }
  });
}

/**
 * Возвращает самый свежий профиль по updatedAt
 */
export function getFreshProfile(
  local: Profile | null,
  cloud: Profile | null
): Profile | null {
  if (!local && !cloud) return null;
  if (local && !cloud) return local;
  if (!local && cloud) return cloud;
  // Оба есть, сравниваем updatedAt
  const localTime = typeof local?.updatedAt === 'number' ? local.updatedAt : 0;
  const cloudTime = typeof cloud?.updatedAt === 'number' ? cloud.updatedAt : 0;
  return localTime >= cloudTime ? local : cloud;
}
