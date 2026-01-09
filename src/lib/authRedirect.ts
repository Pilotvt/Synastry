// Must exactly match Supabase Redirect URLs allow-list.
const DESKTOP_AUTH_REDIRECT = "synastry://auth-callback";

export type AuthRedirectKind = "signup" | "recovery";

export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location?.protocol === "file:") return true;
  return Boolean(window.electronAPI);
}

export function getAuthRedirectUrl(kind: AuthRedirectKind): string {
  if (isDesktopRuntime()) return DESKTOP_AUTH_REDIRECT;
  const rawBase =
    (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)
    ?? (typeof window !== "undefined" ? window.location.origin : "https://synastry.ru");
  const base = /^https?:\/\//i.test(rawBase) ? rawBase : `https://${rawBase.replace(/^\/+/, "")}`;
  const pathname = kind === "recovery" ? "/auth/password-reset" : "/auth/callback";
  return new URL(pathname, base).toString();
}
