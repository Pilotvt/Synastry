import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProfile } from "../store/profile";
import { hardResetAllData } from "../utils/hardReset";
import NewChartConfirmDialog from "./NewChartConfirmDialog";
import { NEW_CHART_REQUEST_EVENT, emitNewChartConfirmed } from "../utils/newChartRequest";

type PendingRequest = {
  origin: string;
};

const NewChartResetGateway: React.FC = () => {
  const navigate = useNavigate();
  const logout = useProfile((state) => state.logout);
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const custom = event as CustomEvent<PendingRequest>;
      setRequest({ origin: custom.detail?.origin ?? "external" });
    };
    window.addEventListener(NEW_CHART_REQUEST_EVENT, handler);
    return () => {
      window.removeEventListener(NEW_CHART_REQUEST_EVENT, handler);
    };
  }, []);

  const handleCancel = useCallback(() => {
    if (busy) return;
    setRequest(null);
  }, [busy]);

  const handleConfirm = useCallback(async () => {
    if (!request) return;
    setBusy(true);
    try {
      await hardResetAllData({ logout });
      emitNewChartConfirmed(request.origin);
      navigate("/app", { replace: true });
    } catch (error) {
      console.warn("Не удалось выполнить полный сброс перед новой картой", error);
    } finally {
      setBusy(false);
      setRequest(null);
    }
  }, [logout, navigate, request]);

  return (
    <NewChartConfirmDialog
      open={Boolean(request)}
      busy={busy}
      onCancel={handleCancel}
      onConfirm={handleConfirm}
    />
  );
};

export default NewChartResetGateway;
