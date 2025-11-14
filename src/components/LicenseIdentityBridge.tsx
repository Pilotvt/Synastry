import { useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

const LicenseIdentityBridge = () => {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = window.electronAPI?.license;
    if (!api?.setIdentity) return;

    let disposed = false;

    const pushIdentity = async (session: Session | null) => {
      if (disposed) return;
      try {
        await api.setIdentity({
          email: session?.user?.email ?? null,
          userId: session?.user?.id ?? null,
        });
      } catch (error) {
        console.warn("Не удалось обновить логин в main-процессе", error);
      }
    };

    supabase.auth
      .getSession()
      .then(({ data }) => pushIdentity(data.session ?? null))
      .catch((error) => console.warn("Не удалось получить supabase session для лицензии", error));

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      pushIdentity(session ?? null);
    });

    return () => {
      disposed = true;
      try {
        data?.subscription?.unsubscribe();
      } catch {}
    };
  }, []);

  return null;
};

export default LicenseIdentityBridge;
