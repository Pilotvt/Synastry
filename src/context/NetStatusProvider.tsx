import React, { useEffect, useMemo, useState } from "react";
import { NetStatusContext } from "./NetStatusContextValue";

export const NetStatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
      return navigator.onLine;
    }
    return true;
  });

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const updateStatus = (status: boolean) => {
      setIsOnline(Boolean(status));
    };

    if (typeof window !== "undefined" && window.electronAPI?.net) {
      window.electronAPI.net
        .getStatus()
        .then(updateStatus)
        .catch(() => {
          // Electron bridge may be missing during local dev; ignore for now.
        });
      cleanup = window.electronAPI.net.onStatusChange(updateStatus);
    } else if (typeof window !== "undefined") {
      const handleOnline = () => updateStatus(true);
      const handleOffline = () => updateStatus(false);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      cleanup = () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const value = useMemo(() => ({ isOnline }), [isOnline]);

  return <NetStatusContext.Provider value={value}>{children}</NetStatusContext.Provider>;
};
