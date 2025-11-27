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

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
