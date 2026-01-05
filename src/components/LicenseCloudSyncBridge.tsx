import { useEffect, useRef } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

const STORAGE_TABLE = "user_licenses";

function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const LicenseCloudSyncBridge = () => {
  const lastSyncedUserIdRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastAppliedRemoteKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = window.electronAPI?.license;
    if (!api?.setIdentity || !api?.getStoredKey || !api?.activate) return;

    let disposed = false;

    const runExclusive = async (task: () => Promise<void>) => {
      const previous = inFlightRef.current;
      if (previous) {
        try {
          await previous;
        } catch {
          // ignore
        }
      }
      const promise = task();
      inFlightRef.current = promise;
      try {
        await promise;
      } finally {
        if (inFlightRef.current === promise) {
          inFlightRef.current = null;
        }
      }
    };

    const syncForSession = async (session: Session | null) => {
      if (disposed) return;

      const userId = session?.user?.id ?? null;
      const email = session?.user?.email ?? null;

      if (!userId) {
        lastSyncedUserIdRef.current = null;
        lastAppliedRemoteKeyRef.current = null;
        return;
      }

      if (lastSyncedUserIdRef.current === userId) return;

      await runExclusive(async () => {
        if (disposed) return;

        try {
          await api.setIdentity({ email, userId });
        } catch (error) {
          console.warn("Не удалось синхронизировать identity для лицензии", error);
        }

        const localKey = normalizeKey(await api.getStoredKey());

        let remoteKey = "";
        try {
          const { data, error } = await supabase
            .from(STORAGE_TABLE)
            .select("license_key")
            .eq("user_id", userId)
            .maybeSingle();

          if (error) {
            if (error.code && error.code !== "42P01") {
              console.warn("Не удалось прочитать user_licenses:", error.message ?? error);
            }
          } else {
            remoteKey = normalizeKey((data as { license_key?: unknown } | null)?.license_key);
          }
        } catch (error) {
          console.warn("Не удалось загрузить лицензию из Supabase", error);
        }

        try {
          if (remoteKey) {
            if (remoteKey !== localKey || lastAppliedRemoteKeyRef.current !== remoteKey) {
              const result = await api.activate(remoteKey);
              if (!result?.success && result?.message) {
                console.warn("Не удалось применить лицензию с сервера:", result.message);
              } else {
                lastAppliedRemoteKeyRef.current = remoteKey;
              }
            }
          } else if (localKey) {
            const { error } = await supabase
              .from(STORAGE_TABLE)
              .upsert(
                {
                  user_id: userId,
                  license_key: localKey,
                  owner_email: email ?? null,
                },
                { onConflict: "user_id" },
              );
            if (error) {
              if (error.code && error.code !== "42P01" && error.code !== "42703") {
                console.warn("Не удалось отправить лицензию в Supabase:", error.message ?? error);
              }
            }
          }
        } catch (error) {
          console.warn("Не удалось синхронизировать лицензию с Supabase", error);
        } finally {
          lastSyncedUserIdRef.current = userId;
        }
      });
    };

    supabase.auth
      .getSession()
      .then(({ data }) => syncForSession(data.session ?? null))
      .catch((error) => console.warn("Не удалось получить session для синхронизации лицензии", error));

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        lastSyncedUserIdRef.current = null;
        lastAppliedRemoteKeyRef.current = null;
        return;
      }
      void syncForSession(session ?? null);
    });

    return () => {
      disposed = true;
      try {
        data?.subscription?.unsubscribe();
      } catch {
        // ignore
      }
    };
  }, []);

  return null;
};

export default LicenseCloudSyncBridge;

