import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { requestNewChartReset } from "../utils/newChartRequest";

const ElectronNavigationBridge: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navigation = window.electronAPI?.navigation;
    if (!navigation?.onOpenApp) return;

    const unsubscribe = navigation.onOpenApp(() => {
      requestNewChartReset("menu");
    });

    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [navigate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navigation = window.electronAPI?.navigation;
    if (!navigation?.onLogout) return;

    const handler = async () => {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.error("Не удалось выйти из учётной записи по меню", error);
      } finally {
        navigate("/", { replace: true });
      }
    };

    const unsubscribe = navigation.onLogout(handler);
    return () => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn("Не удалось отписаться от onLogout", error);
      }
    };
  }, [navigate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navigation = window.electronAPI?.navigation;
    if (!navigation?.onOpenSettings) return;

    const unsubscribe = navigation.onOpenSettings(() => {
      navigate("/settings");
    });

    return () => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn("Не удалось отписаться от onOpenSettings", error);
      }
    };
  }, [navigate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navigation = window.electronAPI?.navigation;
    if (!navigation?.onChangePassword) return;

    const unsubscribe = navigation.onChangePassword(() => {
      navigate("/settings/password");
    });

    return () => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn("Не удалось отписаться от onChangePassword", error);
      }
    };
  }, [navigate]);

  return null;
};

export default ElectronNavigationBridge;
