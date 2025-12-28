import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import AuthPage from "./pages/AuthPage";
import ChartPage from "./pages/ChartPage";
import AdditionalChartPage from "./pages/AdditionalChartPage";
import Questionnaire from "./pages/Questionnaire";
import PhotoView from "./pages/PhotoView";
import UserProfilePage from "./pages/UserProfilePage";
import SinastryPage from "./pages/SinastryPage";
import AuthCallbackPage from "./pages/AuthCallback";
import ChatPopupPage from "./pages/ChatPopupPage";
import SettingsPage from "./pages/SettingsPage";
import BlacklistSettingsPage from "./pages/BlacklistSettingsPage";
import BlocklistPopupPage from "./pages/BlocklistPopupPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import PasswordRecoveryPage from "./pages/PasswordRecoveryPage";
import NetStatusBanner from "./components/NetStatusBanner";
import { NetStatusProvider } from "./context/NetStatusProvider";
import LicenseIdentityBridge from "./components/LicenseIdentityBridge";
import ElectronNavigationBridge from "./components/ElectronNavigationBridge";
import AuthDeepLinkBridge from "./components/AuthDeepLinkBridge";
import AppBoundary from "./components/AppBoundary";
import LastSeenHeartbeat from "./components/LastSeenHeartbeat";
import NewChartResetGateway from "./components/NewChartResetGateway";
import BlocklistBootstrapper from "./components/BlocklistBootstrapper";
import OfflineModeEnforcer from "./components/OfflineModeEnforcer";
import "./index.css";

const RouterComponent = window.location.protocol === "file:" ? HashRouter : BrowserRouter;

// Capture unexpectedly swallowed errors (as a last resort)
if (typeof window !== "undefined") {
  const showFatal = (label: string, payload: unknown) => {
    try {
      const el = document.getElementById("root");
      if (!el) return;
      const message = typeof payload === "string" ? payload : ((payload as { message?: string })?.message || String(payload));
      el.innerHTML = `<div style="min-height:100vh;background:#0b1220;color:#fff;padding:16px"><h1 style="font-size:18px;margin-bottom:8px">${label}</h1><pre style="white-space:pre-wrap;font-size:12px">${message}</pre></div>`;
    } catch (error) {
      console.error("Не удалось показать фатальную ошибку", error);
    }
  };
  window.addEventListener("error", (e) => {
    try {
      console.error("window.onerror:", e.error || e.message);
    } catch (logError) {
      console.warn("Не удалось залогировать window.onerror", logError);
    }
    showFatal("Ошибка выполнения", e.error || e.message);
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    try {
      console.error("unhandledrejection:", e.reason);
    } catch (logError) {
      console.warn("Не удалось залогировать unhandledrejection", logError);
    }
    showFatal("Необработанное исключение", e.reason);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NetStatusProvider>
      <NetStatusBanner />
      <RouterComponent>
        <ElectronNavigationBridge />
        <AuthDeepLinkBridge />
        <LicenseIdentityBridge />
        <BlocklistBootstrapper />
        <OfflineModeEnforcer />
        <AppBoundary>
          <LastSeenHeartbeat />
          <NewChartResetGateway />
          <Routes>
            <Route path="/" element={<AuthPage />} />
            <Route path="/app" element={<App />} />
            <Route path="/chart" element={<ChartPage />} />
            <Route path="/chart/additional" element={<AdditionalChartPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="/auth/password-reset" element={<PasswordRecoveryPage />} />
            <Route path="/questionnaire" element={<Questionnaire />} />
            <Route path="/photo/:userId/:idx" element={<PhotoView />} />
            <Route path="/user/:userId" element={<UserProfilePage />} />
            <Route path="/sinastry" element={<SinastryPage />} />
            <Route path="/chat-popup" element={<ChatPopupPage />} />
            <Route path="/blocklist-popup" element={<BlocklistPopupPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/blacklist" element={<BlacklistSettingsPage />} />
            <Route path="/settings/password" element={<ChangePasswordPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppBoundary>
      </RouterComponent>
    </NetStatusProvider>
  </React.StrictMode>,
);
