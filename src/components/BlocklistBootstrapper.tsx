import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchBlockedProfiles } from "../lib/blocklist";
import { useBlocklistStore } from "../store/blocklist";

const BlocklistBootstrapper: React.FC = () => {
  const setEntries = useBlocklistStore((state) => state.setEntries);
  const setLoading = useBlocklistStore((state) => state.setLoading);
  const setError = useBlocklistStore((state) => state.setError);
  const reset = useBlocklistStore((state) => state.reset);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let subscription: { unsubscribe?: () => void } | null = null;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setUserId(data.session?.user?.id ?? null);
      })
      .catch(() => {
        if (!mounted) return;
        setUserId(null);
      });

    try {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!mounted) return;
        setUserId(session?.user?.id ?? null);
      });
      subscription = data?.subscription ?? null;
    } catch (error) {
      console.warn("Не удалось подписаться на изменение авторизации для чёрного списка", error);
    }

    return () => {
      mounted = false;
      try {
        subscription?.unsubscribe?.();
      } catch (error) {
        console.warn("Не удалось снять подписку чёрного списка", error);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      reset();
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    fetchBlockedProfiles(userId)
      .then((entries) => {
        if (cancelled) return;
        setEntries(entries);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("Не удалось загрузить чёрный список", error);
        setError("Не удалось загрузить чёрный список.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, setEntries, setLoading, setError, reset]);

  return null;
};

export default BlocklistBootstrapper;
