import { useEffect, useMemo, useState } from "react";

const OFFLINE_MODE_KEY = "synastry:offline-mode";
const OFFLINE_MODE_EVENT = "synastry:offline-mode-changed";

export function getOfflineMode(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(OFFLINE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOfflineMode(enabled: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (enabled) {
      window.localStorage.setItem(OFFLINE_MODE_KEY, "1");
    } else {
      window.localStorage.removeItem(OFFLINE_MODE_KEY);
    }
    window.dispatchEvent(new Event(OFFLINE_MODE_EVENT));
  } catch {
    // ignore
  }
}

export function useOfflineMode(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => getOfflineMode());

  useEffect(() => {
    const handler = () => setEnabled(getOfflineMode());
    window.addEventListener(OFFLINE_MODE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(OFFLINE_MODE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const setter = useMemo(() => (next: boolean) => setOfflineMode(next), []);
  return [enabled, setter];
}

