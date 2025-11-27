import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

function paramsFromDeepLinkPayload(payload: ElectronAuthDeepLinkPayload | null | undefined): URLSearchParams {
  if (payload && typeof payload.hash === "string" && payload.hash.length > 1) {
    const trimmed = payload.hash.startsWith("#") ? payload.hash.slice(1) : payload.hash;
    return new URLSearchParams(trimmed);
  }
  if (payload && typeof payload.search === "string" && payload.search.length > 1) {
    const trimmed = payload.search.startsWith("?") ? payload.search.slice(1) : payload.search;
    return new URLSearchParams(trimmed);
  }
  return new URLSearchParams();
}

const AuthDeepLinkBridge: React.FC = () => {
  const navigate = useNavigate();
  const seenLinksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bridge = window.electronAPI?.auth;
    if (!bridge?.onDeepLink) return;

    const applyPayload = async (payload: ElectronAuthDeepLinkPayload | null) => {
      if (!payload) return;
      const signature = payload.rawUrl || `${payload.hash ?? ""}|${payload.search ?? ""}`;
      if (seenLinksRef.current.has(signature)) {
        return;
      }
      seenLinksRef.current.add(signature);

      try {
        const params = paramsFromDeepLinkPayload(payload);
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        if (!accessToken || !refreshToken) {
          console.warn("Auth deep link без токенов", payload);
          return;
        }
        const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (error) {
          console.warn("Не удалось применить сессию из ссылки", error);
          return;
        }
        try {
          await bridge.acknowledge?.();
        } catch (ackError) {
          console.warn("Не удалось подтвердить обработку ссылки", ackError);
        }
        const eventType = (params.get("type") ?? params.get("event") ?? "").toLowerCase();
        const isRecovery = eventType === "recovery" || eventType === "password_recovery";
        navigate(isRecovery ? "/auth/password-reset" : "/app", { replace: true });
      } catch (error) {
        console.warn("Ошибка обработки auth deep link", error);
      }
    };

    const unsubscribe = bridge.onDeepLink((payload) => {
      void applyPayload(payload ?? null);
    });

    if (typeof bridge.getPending === "function") {
      bridge
        .getPending()
        .then((payload) => {
          void applyPayload(payload);
        })
        .catch((error) => {
          console.warn("Не удалось получить отложенную auth-ссылку", error);
        });
    }

    return () => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn("Не удалось удалить подписку auth deep link", error);
      }
    };
  }, [navigate]);

  return null;
};

export default AuthDeepLinkBridge;
