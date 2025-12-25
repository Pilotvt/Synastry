import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useOfflineMode } from "../utils/offlineMode";

export default function OfflineModeEnforcer() {
  const [offlineModeEnabled] = useOfflineMode();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!offlineModeEnabled) return;
    const path = location.pathname || "/";
    const allowed =
      path === "/" ||
      path === "/chart/additional" ||
      path.startsWith("/auth/");
    if (allowed) return;
    navigate("/chart/additional", { replace: true });
  }, [location.pathname, navigate, offlineModeEnabled]);

  return null;
}

