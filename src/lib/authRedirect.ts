const DESKTOP_AUTH_REDIRECT = "synastry://auth-callback";

export type AuthRedirectKind = "signup" | "recovery";

export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location?.protocol === "file:") return true;
  return Boolean(window.electronAPI);
}

export function getAuthRedirectUrl(kind: AuthRedirectKind): string {
  if (isDesktopRuntime()) return DESKTOP_AUTH_REDIRECT;
  const base = typeof window !== "undefined" ? window.location.origin : "https://synastry.ru";
  const pathname = kind === "recovery" ? "/auth/password-reset" : "/auth/callback";
  return new URL(pathname, base).toString();
}

