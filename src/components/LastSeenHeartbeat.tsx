import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useNetStatus } from "../context/useNetStatus";

const HEARTBEAT_INTERVAL_MS = 60_000;
const OFFLINE_GRACE_MS = 5_000;

async function touchLastSeen(userId: string) {
  try {
    await supabase.rpc("touch_last_seen", { p_user_id: userId });
  } catch (error) {
    console.warn("Не удалось обновить last_seen", error);
  }
}

const LastSeenHeartbeat: React.FC = () => {
  const { isOnline } = useNetStatus();
  const [userId, setUserId] = useState<string | null>(null);
  const lastPingRef = useRef(0);

  useEffect(() => {
    let isMounted = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!isMounted) return;
        setUserId(data.session?.user?.id ?? null);
      })
      .catch((error) => console.warn("Не удалось получить сессию для last_seen", error));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      setUserId(session?.user?.id ?? null);
    });
    return () => {
      isMounted = false;
      data?.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!userId || !isOnline) return;
    let cancelled = false;

    const maybePing = async () => {
      if (!userId || cancelled) return;
      const now = Date.now();
      if (now - lastPingRef.current < OFFLINE_GRACE_MS) return;
      lastPingRef.current = now;
      await touchLastSeen(userId);
    };

    void maybePing();

    const interval = setInterval(() => {
      void maybePing();
    }, HEARTBEAT_INTERVAL_MS);

    const visibilityHandler = () => {
      if (!document.hidden) {
        void maybePing();
      }
    };

    document.addEventListener("visibilitychange", visibilityHandler);

    const focusHandler = () => {
      void maybePing();
    };
    window.addEventListener("focus", focusHandler);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("focus", focusHandler);
    };
  }, [userId, isOnline]);

  return null;
};

export default LastSeenHeartbeat;
