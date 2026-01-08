import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchBlockedProfiles } from "../lib/blocklist";
import { useBlocklistStore, type BlockedProfileSummary } from "../store/blocklist";

const BLOCKLIST_CACHE_KEY = "synastry.blocklist.cache.v1";

const BlocklistBootstrapper: React.FC = () => {
  const setEntries = useBlocklistStore((state) => state.setEntries);
  const setEntriesWithTimestamp = useBlocklistStore((state) => state.setEntriesWithTimestamp);
  const setLoading = useBlocklistStore((state) => state.setLoading);
  const setError = useBlocklistStore((state) => state.setError);
  const reset = useBlocklistStore((state) => state.reset);
  const entriesMap = useBlocklistStore((state) => state.entries);
  const lastLoadedAt = useBlocklistStore((state) => state.lastLoadedAt);
  const [userId, setUserId] = useState<string | null>(null);
  const lastAppliedRef = useRef(0);
  const lastWrittenRef = useRef(0);

  const entries = useMemo(() => Object.values(entriesMap), [entriesMap]);

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
    lastAppliedRef.current = 0;
    lastWrittenRef.current = 0;
  }, [userId]);

  const applyCachedPayload = useCallback(
    (payload: { userId?: string; updatedAt?: number; entries?: unknown } | null) => {
      if (!payload || !userId || payload.userId !== userId) return;
      const updatedAt = Number(payload.updatedAt);
      if (!Number.isFinite(updatedAt)) return;
      if (updatedAt <= lastAppliedRef.current) return;
      if (!Array.isArray(payload.entries)) return;
      setEntriesWithTimestamp(payload.entries as BlockedProfileSummary[], updatedAt);
      lastAppliedRef.current = updatedAt;
      lastWrittenRef.current = updatedAt;
    },
    [userId, setEntriesWithTimestamp],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!userId) return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== BLOCKLIST_CACHE_KEY) return;
      if (!event.newValue) return;
      try {
        const parsed = JSON.parse(event.newValue);
        applyCachedPayload(parsed);
      } catch {
        // ignore malformed cache
      }
    };

    try {
      const raw = localStorage.getItem(BLOCKLIST_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        applyCachedPayload(parsed);
      }
    } catch {
      // ignore cache read errors
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [applyCachedPayload, userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!userId) return;
    const updatedAt = Number.isFinite(lastLoadedAt ?? NaN) ? (lastLoadedAt as number) : Date.now();
    if (updatedAt <= lastWrittenRef.current) return;
    try {
      const payload = { userId, updatedAt, entries };
      localStorage.setItem(BLOCKLIST_CACHE_KEY, JSON.stringify(payload));
      lastWrittenRef.current = updatedAt;
    } catch {
      // ignore cache write errors
    }
  }, [userId, entries, lastLoadedAt]);

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
