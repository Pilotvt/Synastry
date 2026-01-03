import { createClient } from "@supabase/supabase-js";

const sanitizeHeaderValue = (raw: string, label: string): string => {
  let mutated = false;
  const filtered = Array.from(raw)
    .filter((char) => {
      const code = char.charCodeAt(0);
      const isAscii = code >= 0x20 && code <= 0x7e;
      if (!isAscii) {
        mutated = true;
      }
      return isAscii;
    })
    .join("");
  const trimmed = filtered.trim();
  if (mutated) {
    console.warn(`[supabase] ${label} contained non-ASCII characters and was sanitized. Verify your .env file.`);
  }
  return trimmed;
};

const sanitizeUrl = (raw: string): string => raw.trim().replace(/\s+/g, "");

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

const supabaseUrl = sanitizeUrl(rawSupabaseUrl);
const supabaseAnonKey = sanitizeHeaderValue(rawSupabaseAnonKey, "anon key");

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
}

type CachedFetchResponse = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyText: string;
};

let refreshTokenInFlight: Promise<CachedFetchResponse> | null = null;
let refreshCooldownUntil = 0;

const responseFromCache = (cached: CachedFetchResponse): Response => {
  return new Response(cached.bodyText, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
};

const resolveUrlString = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const isRefreshTokenRequest = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/auth/v1/token") && parsed.searchParams.get("grant_type") === "refresh_token";
  } catch {
    return url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token");
  }
};

const baseFetch: typeof fetch = (input, init) => fetch(input, init);

const fetchWithRefreshDedup: typeof fetch = async (input, init) => {
  const url = resolveUrlString(input);
  if (!isRefreshTokenRequest(url)) {
    return baseFetch(input, init);
  }

  const now = Date.now();
  if (now < refreshCooldownUntil) {
    return new Response(JSON.stringify({ error: "rate_limited", error_description: "Refresh token is temporarily rate limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (refreshTokenInFlight) {
    const cached = await refreshTokenInFlight;
    return responseFromCache(cached);
  }

  refreshTokenInFlight = (async () => {
    const res = await baseFetch(input, init);
    const cached: CachedFetchResponse = {
      status: res.status,
      statusText: res.statusText,
      headers: Array.from(res.headers.entries()),
      bodyText: await res.clone().text(),
    };

    // Avoid refresh storms from multiple windows/components (and from incorrect system time).
    refreshCooldownUntil = Date.now() + (res.status === 429 ? 15_000 : 1_000);

    return cached;
  })();

  try {
    const cached = await refreshTokenInFlight;
    return responseFromCache(cached);
  } finally {
    refreshTokenInFlight = null;
  }
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: fetchWithRefreshDedup,
  },
  auth: {
    detectSessionInUrl: false,
  },
});
