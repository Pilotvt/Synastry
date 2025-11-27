import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { refreshBlocklistForUser, unblockUser } from "../lib/blocklist";
import { useBlocklistStore } from "../store/blocklist";

export const useBlocklistController = () => {
  const entriesMap = useBlocklistStore((state) => state.entries);
  const loading = useBlocklistStore((state) => state.loading);
  const storeError = useBlocklistStore((state) => state.error);
  const initialized = useBlocklistStore((state) => state.initialized);
  const removeEntry = useBlocklistStore((state) => state.removeEntry);

  const [userId, setUserId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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
      console.warn("Не удалось подписаться на изменение состояния авторизации для блок-листа", error);
    }

    return () => {
      mounted = false;
      try {
        subscription?.unsubscribe?.();
      } catch (error) {
        console.warn("Не удалось снять подписку с auth state для блок-листа", error);
      }
    };
  }, []);

  const entries = useMemo(() => {
    return Object.values(entriesMap).sort((a, b) => (a.blockedAt < b.blockedAt ? 1 : -1));
  }, [entriesMap]);

  const handleUnblock = useCallback(
    async (targetId: string) => {
      if (!userId) {
        setLocalError("Сначала войдите в аккаунт, чтобы управлять блокировками.");
        return;
      }
      setBusyId(targetId);
      setLocalError(null);
      try {
        await unblockUser(userId, targetId);
        removeEntry(targetId);
      } catch (error) {
        console.warn("Не удалось разблокировать пользователя", error);
        setLocalError("Не получилось разблокировать пользователя. Попробуйте позже.");
      } finally {
        setBusyId(null);
      }
    },
    [userId, removeEntry],
  );

  const handleRefresh = useCallback(async () => {
    if (!userId) {
      setLocalError("Сначала войдите в аккаунт, чтобы обновить блок-лист.");
      return;
    }
    setRefreshing(true);
    setLocalError(null);
    try {
      await refreshBlocklistForUser(userId);
    } catch (error) {
      console.warn("Не удалось обновить блок-лист", error);
      setLocalError("Не получилось обновить список блокировок. Попробуйте позже.");
    } finally {
      setRefreshing(false);
    }
  }, [userId]);

  return {
    userId,
    entries,
    loading,
    initialized,
    storeError,
    localError,
    refreshing,
    busyId,
    handleUnblock,
    handleRefresh,
  };
};

export type UseBlocklistControllerReturn = ReturnType<typeof useBlocklistController>;
