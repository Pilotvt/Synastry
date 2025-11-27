import { create } from "zustand";

export type Profile = {
  id?: string;
  email?: string;
  firstName: string;
  lastName: string;
  birth?: string;
  gender?: 'male' | 'female';
  country?: string;
  cityName?: string;
  cityNameRu?: string;
  residenceCountry?: string;
  residenceCityName?: string;
  cityId?: string;
  lat?: number;
  lon?: number;
  ascSign?: string;
  updatedAt: number;
};

type State = {
  profile: Profile;
  lastSavedFingerprint: string | null;
  setProfile: (patch: Partial<Profile>) => void;
  setLastSavedFingerprint: (fp: string | null) => void;
  loadFromLocal: () => void;
  logout: () => void;
};

const STORAGE_KEY = "syn_ui_profile_v2";

export const useProfile = create<State>((set, get) => ({
  profile: { firstName: "", lastName: "", updatedAt: 0 },
  lastSavedFingerprint: null,

  setProfile: (patch) => {
    const next = { ...get().profile, ...patch, updatedAt: Date.now() };
    set({ profile: next });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn("Не удалось сохранить профиль в localStorage", error);
    }
  },

  setLastSavedFingerprint: (fp) => {
    set({ lastSavedFingerprint: fp });
  },

  loadFromLocal: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      set({ profile: JSON.parse(raw) as Profile });
    } catch (error) {
      console.warn("Не удалось загрузить профиль из localStorage", error);
    }
  },

  logout: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn("Не удалось очистить профиль из localStorage", error);
    }
    set({ profile: { firstName: "", lastName: "", updatedAt: 0 }, lastSavedFingerprint: null });
  },
}));

// синхронизация между вкладками
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        useProfile.setState({ profile: JSON.parse(e.newValue) as Profile });
      } catch (error) {
        console.warn("Не удалось синхронизировать профиль между вкладками", error);
      }
    }
  });
}



// ...existing code...



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

