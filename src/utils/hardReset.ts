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
  preserveCloudChartFingerprints?: boolean;
  cloudStorageCleanup?: "sync" | "async" | false;
};

export function resetLocalUserData(
  options?: Pick<HardResetOptions, "logout" | "preserveCloudChartFingerprints">,
) {
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
    if (!options?.preserveCloudChartFingerprints) {
      localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
    }
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

async function deleteStorageFolderContents(params: {
  bucket: string;
  prefix: string;
  search?: string;
  filterNamePrefix?: string;
}) {
  const { bucket, prefix, search, filterNamePrefix } = params;
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit,
      offset,
      search,
      sortBy: { column: "name", order: "asc" },
    });
    if (error || !Array.isArray(data) || data.length === 0) break;
    const paths = data
      .map((item) => (item && typeof item.name === "string" ? item.name : ""))
      .filter(Boolean)
      .filter((name) => (filterNamePrefix ? name.startsWith(filterNamePrefix) : true))
      .map((name) => {
        const base = prefix ? `${prefix.replace(/\/+$/, "")}/` : "";
        return `${base}${name}`;
      });
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      try {
        const { error: removeError } = await supabase.storage.from(bucket).remove(batch);
        if (removeError) {
          console.warn("Не удалось удалить файлы из Storage", { bucket, removeError });
        }
      } catch (removeError) {
        console.warn("Storage remove failed", { bucket, removeError });
      }
    }
    offset += data.length;
    if (data.length < limit) break;
  }
}

async function cleanupUserStorageFiles(userId: string) {
  const photoBuckets = ["profile-photos", "profiles-photos", "avatars", "public"];
  const screenshotBuckets = ["charts-screenshots", "charts", "public", "screenshots"];
  const tasks: Array<Promise<void>> = [];

  for (const bucket of photoBuckets) {
    tasks.push(
      deleteStorageFolderContents({ bucket, prefix: `profiles/${userId}`, search: undefined }).catch((error) => {
        console.warn("Failed to cleanup profile photos bucket", { bucket, error });
      }),
    );
  }

  const chartPrefix = `chart-${userId}-`;
  for (const bucket of screenshotBuckets) {
    tasks.push(
      // Root-level files, use search to avoid listing the entire bucket.
      deleteStorageFolderContents({ bucket, prefix: "", search: chartPrefix, filterNamePrefix: chartPrefix }).catch(
        (error) => {
          console.warn("Failed to cleanup chart screenshots bucket", { bucket, error });
        },
      ),
    );
  }

  await Promise.all(tasks);
}

export async function resetCloudUserData(options?: Pick<HardResetOptions, "cloudStorageCleanup">) {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) return;
    const cleanupMode = options?.cloudStorageCleanup ?? "async";
    const cleanupPromise =
      cleanupMode === false ? null : cleanupUserStorageFiles(userId).catch((error) => {
        console.warn("Не удалось очистить файлы пользователя в Supabase Storage", error);
      });

    await Promise.all([
      supabase.from("profiles").delete().eq("id", userId),
      supabase.from("charts").delete().eq("user_id", userId),
    ]);

    if (cleanupPromise) {
      if (cleanupMode === "sync") {
        await cleanupPromise;
      } else {
        void cleanupPromise;
      }
    }
  } catch (error) {
    console.warn("Не удалось очистить данные в Supabase", error);
    throw error;
  }
}

export async function hardResetAllData(options?: HardResetOptions) {
  const preserveCloudChartFingerprints =
    options?.preserveCloudChartFingerprints ?? options?.clearCloud === false;
  resetLocalUserData({ logout: options?.logout, preserveCloudChartFingerprints });
  if (options?.clearCloud === false) {
    return;
  }
  try {
    await resetCloudUserData({ cloudStorageCleanup: options?.cloudStorageCleanup ?? "async" });
  } catch {
    // уже залогировано, продолжаем, чтобы пользователь попал на экран новой карты
  }
}
