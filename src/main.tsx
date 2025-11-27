import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import AuthPage from "./pages/AuthPage";
import ChartPage from "./pages/ChartPage";
import NetStatusBanner from "./components/NetStatusBanner";
import { NetStatusProvider } from "./context/NetStatusProvider";
import LicenseIdentityBridge from "./components/LicenseIdentityBridge";
import ElectronNavigationBridge from "./components/ElectronNavigationBridge";
import AuthDeepLinkBridge from "./components/AuthDeepLinkBridge";
import AppBoundary from "./components/AppBoundary";
import LastSeenHeartbeat from "./components/LastSeenHeartbeat";
import NewChartResetGateway from "./components/NewChartResetGateway";
import BlocklistBootstrapper from "./components/BlocklistBootstrapper";
const Questionnaire = React.lazy(() => import("./pages/Questionnaire"));
const PhotoView = React.lazy(() => import("./pages/PhotoView"));
const UserProfilePage = React.lazy(() => import("./pages/UserProfilePage"));
const SinastryPage = React.lazy(() => import("./pages/SinastryPage"));
const AuthCallbackPage = React.lazy(() => import("./pages/AuthCallback"));
const ChatPopupPage = React.lazy(() => import("./pages/ChatPopupPage"));
const SettingsPage = React.lazy(() => import("./pages/SettingsPage"));
const BlacklistSettingsPage = React.lazy(() => import("./pages/BlacklistSettingsPage"));
const BlocklistPopupPage = React.lazy(() => import("./pages/BlocklistPopupPage"));
const ChangePasswordPage = React.lazy(() => import("./pages/ChangePasswordPage"));
const PasswordRecoveryPage = React.lazy(() => import("./pages/PasswordRecoveryPage"));
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
        <AppBoundary>
        <LastSeenHeartbeat />
        <NewChartResetGateway />
        <Routes>
          <Route path="/" element={<AuthPage />} />
          <Route path="/app" element={<App />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route
            path="/auth/callback"
            element={
              <React.Suspense fallback={<>...</>}>
          <Route
            path="/settings/blacklist"
            element={
              <React.Suspense fallback={<>...</>}>
                <BlacklistSettingsPage />
              </React.Suspense>
            }
          />
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
          <Route
            path="/blocklist-popup"
            element={
              <React.Suspense fallback={<>...</>}>
                <BlocklistPopupPage />
              </React.Suspense>
            }
          />
          <Route
            path="/settings"
            element={
              <React.Suspense fallback={<>...</>}>
                <SettingsPage />
              </React.Suspense>
            }
          />
          <Route
            path="/settings/password"
            element={
              <React.Suspense fallback={<>...</>}>
                <ChangePasswordPage />
              </React.Suspense>
            }
          />
          <Route
            path="/auth/password-reset"
            element={
              <React.Suspense fallback={<>...</>}>
                <PasswordRecoveryPage />
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
