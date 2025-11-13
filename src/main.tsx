import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import App from "./App";
import AuthPage from "./pages/AuthPage";
import ChartPage from "./pages/ChartPage";
import NetStatusBanner from "./components/NetStatusBanner";
import { NetStatusProvider } from "./context/NetStatusContext";
import LicenseIdentityBridge from "./components/LicenseIdentityBridge";
import { supabase } from "./lib/supabase";
const Questionnaire = React.lazy(() => import("./pages/Questionnaire"));
const PhotoView = React.lazy(() => import("./pages/PhotoView"));
const UserProfilePage = React.lazy(() => import("./pages/UserProfilePage"));
const SinastryPage = React.lazy(() => import("./pages/SinastryPage"));
const AuthCallbackPage = React.lazy(() => import("./pages/AuthCallback"));
const ChatPopupPage = React.lazy(() => import("./pages/ChatPopupPage"));
import "./index.css";

const RouterComponent = window.location.protocol === "file:" ? HashRouter : BrowserRouter;

function ElectronNavigationBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navigation = window.electronAPI?.navigation;
    if (!navigation?.onOpenApp) return;

    const unsubscribe = navigation.onOpenApp(() => {
      navigate("/app");
    });

    return () => {
      unsubscribe?.();
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
      try { unsubscribe?.(); } catch {}
    };
  }, [navigate]);

  return null;
}

// Simple error boundary to surface runtime errors instead of blank screen
class AppBoundary extends React.Component<{ children: React.ReactNode }, { error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  componentDidCatch(error: any, info: any) {
    try { console.error("App error boundary:", error, info); } catch {}
  }
  render() {
    if (this.state.error) {
      const msg = (this.state.error && (this.state.error.message || String(this.state.error))) || "Unknown error";
      return (
        <div style={{ minHeight: "100vh", background: "#0b1220", color: "#fff", padding: 16 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Произошла ошибка выполнения</h1>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{msg}</pre>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

// Capture unexpectedly swallowed errors (as a last resort)
if (typeof window !== "undefined") {
  const showFatal = (label: string, payload: any) => {
    try {
      const el = document.getElementById("root");
      if (!el) return;
      const message = typeof payload === "string" ? payload : (payload?.message || String(payload));
      el.innerHTML = `<div style=\"min-height:100vh;background:#0b1220;color:#fff;padding:16px\"><h1 style=\"font-size:18px;margin-bottom:8px\">${label}</h1><pre style=\"white-space:pre-wrap;font-size:12px\">${message}</pre></div>`;
    } catch {}
  };
  window.addEventListener("error", (e) => {
    try { console.error("window.onerror:", e.error || e.message); } catch {}
    showFatal("Ошибка выполнения", e.error || e.message);
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    try { console.error("unhandledrejection:", e.reason); } catch {}
    showFatal("Необработанное исключение", e.reason);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NetStatusProvider>
      <NetStatusBanner />
      <RouterComponent>
        <ElectronNavigationBridge />
        <LicenseIdentityBridge />
        <AppBoundary>
        <Routes>
          <Route path="/" element={<AuthPage />} />
          <Route path="/app" element={<App />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route
            path="/auth/callback"
            element={
              <React.Suspense fallback={<>...</>}>
                <AuthCallbackPage />
              </React.Suspense>
            }
          />
          <Route
            path="/questionnaire"
            element={
              <React.Suspense fallback={<>...</>}>
                <Questionnaire />
              </React.Suspense>
            }
          />
          <Route
            path="/photo/:userId/:idx"
            element={
              <React.Suspense fallback={<>...</>}>
                <PhotoView />
              </React.Suspense>
            }
          />
          <Route
            path="/user/:userId"
            element={
              <React.Suspense fallback={<>...</>}>
                <UserProfilePage />
              </React.Suspense>
            }
          />
          <Route
            path="/sinastry"
            element={
              <React.Suspense fallback={<>...</>}>
                <SinastryPage />
              </React.Suspense>
            }
          />
          <Route
            path="/chat-popup"
            element={
              <React.Suspense fallback={<>...</>}>
                <ChatPopupPage />
              </React.Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </AppBoundary>
      </RouterComponent>
    </NetStatusProvider>
  </React.StrictMode>,
);
