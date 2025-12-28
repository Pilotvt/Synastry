import PROFANITY_RAW from "../../data/profanity_ru_ua.txt?raw";

function normalizeToken(token: string): string {
  return token.trim().toLowerCase().replace(/ё/g, "е");
}

function parseWordList(raw: string): Set<string> {
  const set = new Set<string>();
  const text = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    const word = normalizeToken(trimmed);
    if (word) set.add(word);
  }
  return set;
}

let cachedSet: Set<string> | null = null;

export function getProfanityWordSet(): Set<string> {
  if (!cachedSet) cachedSet = parseWordList(PROFANITY_RAW);
  return cachedSet;
}

// Include common obfuscation characters used in profanity lists (apostrophes, backticks, underscores, hyphens).
const TOKEN_RE = /[0-9a-zа-яё'’`_-]+/giu;

export function findProfanityMatches(text: string): string[] {
  if (!text) return [];
  const dict = getProfanityWordSet();
  const matches: string[] = [];
  for (const m of String(text).matchAll(TOKEN_RE)) {
    const token = String(m[0] ?? "");
    const key = normalizeToken(token);
    if (key && dict.has(key)) matches.push(token);
  }
  return Array.from(new Set(matches.map((m) => m.trim()).filter(Boolean)));
}

export function censorProfanity(text: string, replacement = "***"): { censored: string; matches: string[] } {
  if (!text) return { censored: "", matches: [] };
  const dict = getProfanityWordSet();
  const matches: string[] = [];
  const censored = String(text).replace(TOKEN_RE, (token) => {
    const key = normalizeToken(token);
    if (key && dict.has(key)) {
      matches.push(token);
      return replacement;
    }
    return token;
  });
  return { censored, matches: Array.from(new Set(matches.map((m) => m.trim()).filter(Boolean))) };
}
