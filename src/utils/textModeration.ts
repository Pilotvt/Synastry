import { moderateText } from "../services/moderation";
import { findProfanityMatches } from "./profanityDictionary";

export type TextModerationCheck = {
  isClean: boolean;
  matches: string[];
  reasons: string[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function normalizeForRemoteModeration(text: string): string {
  return String(text)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

export function findLocalProfanityMatches(text: string): string[] {
  return unique(findProfanityMatches(text));
}

export async function checkTextModeration(
  text: string,
  options?: { languageHint?: string; remoteTimeoutMs?: number },
): Promise<TextModerationCheck> {
  const trimmed = text.trim();
  if (!trimmed) return { isClean: true, matches: [], reasons: [] };

  const localMatches = findLocalProfanityMatches(trimmed);
  if (localMatches.length > 0) {
    return { isClean: false, matches: localMatches, reasons: ["Локальный фильтр"] };
  }

  const timeoutMs = options?.remoteTimeoutMs ?? 1500;
  try {
    const remoteText = normalizeForRemoteModeration(trimmed);
    const verdict = await Promise.race([
      moderateText(remoteText, options?.languageHint ?? "ru"),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (verdict && !verdict.isClean) {
      return {
        isClean: false,
        matches: Array.isArray(verdict.matches) ? verdict.matches : [],
        reasons: Array.isArray(verdict.reasons) ? verdict.reasons : ["Обнаружена ненормативная лексика"],
      };
    }
  } catch {
    // ignore remote errors, rely on local filter
  }

  return { isClean: true, matches: [], reasons: [] };
}
