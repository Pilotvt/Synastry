import { supabase } from "../supabase";
import { clearSavedChart } from "./savedChartStorage";
import { clearProfileStorage } from "./profileStorage";
import {
  PROFILE_SNAPSHOT_STORAGE_KEY,
  LAST_SAVED_CHART_FINGERPRINT_KEY,
  LAST_SAVED_PROFILE_FINGERPRINT_KEY,
} from "../constants/storageKeys";

export type HardResetOptions = {
  clearCloud?: boolean;
  logout?: () => void;
};

export function resetLocalUserData(options?: Pick<HardResetOptions, "logout">) {
  try {
    clearSavedChart();
  } catch (error) {
    console.warn("Не удалось очистить локальный расчёт", error);
  }
  try {
    clearProfileStorage(PROFILE_SNAPSHOT_STORAGE_KEY);
  } catch (error) {
    console.warn("Не удалось очистить локальный профиль", error);
  }
  try {
    localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
  } catch (error) {
    console.warn("Не удалось удалить хеш сохранённой карты", error);
  }
  try {
    localStorage.removeItem(LAST_SAVED_PROFILE_FINGERPRINT_KEY);
  } catch (error) {
    console.warn("Не удалось удалить хеш анкеты", error);
  }
  try {
    options?.logout?.();
  } catch (error) {
    console.warn("Не удалось сбросить стор профиля", error);
  }
}

export async function resetCloudUserData() {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) return;
    await supabase.from("profiles").delete().eq("id", userId);
    await supabase.from("charts").delete().eq("user_id", userId);
  } catch (error) {
    console.warn("Не удалось очистить данные в Supabase", error);
    throw error;
  }
}

export async function hardResetAllData(options?: HardResetOptions) {
  resetLocalUserData({ logout: options?.logout });
  if (options?.clearCloud === false) {
    return;
  }
  try {
    await resetCloudUserData();
  } catch {
    // уже залогировано, продолжаем, чтобы пользователь попал на экран новой карты
  }
}
