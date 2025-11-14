export type StoredProfileRecord<T> = {
  profile: T | null;
  ownerId: string | null | undefined;
  raw: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveOwner = (value: unknown): string | null | undefined => {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return undefined;
};

export function readProfileFromStorage<T>(storageKey: string): StoredProfileRecord<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const ownerId =
      parsed && typeof parsed === "object" && "ownerId" in parsed
        ? resolveOwner((parsed as { ownerId?: unknown }).ownerId)
        : undefined;
    let profile: T | null = null;
    if (parsed && typeof parsed === "object" && "profile" in parsed) {
      profile = (((parsed as Record<string, unknown>).profile as T | null | undefined) ?? null);
    } else {
      profile = parsed as T;
    }
    return { profile: profile ?? null, ownerId, raw: parsed };
  } catch (error) {
    console.warn("Failed to read profile from storage", error);
    return null;
  }
}

export function writeProfileToStorage<T>(
  storageKey: string,
  profile: T,
  ownerId?: string | null,
  mergeExisting = true,
) {
  if (typeof window === "undefined") return;
  try {
    let base: Record<string, unknown> = {};
    if (mergeExisting) {
      const existingRaw = localStorage.getItem(storageKey);
      if (existingRaw) {
        try {
          const existingParsed = JSON.parse(existingRaw) as unknown;
          if (isPlainObject(existingParsed)) {
            base = { ...existingParsed };
          }
        } catch {
          // ignore parse errors, fall back to clean payload
        }
      }
    }
    const payload = { ...base, ownerId: ownerId ?? null, profile };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to write profile snapshot", error);
  }
}

export function isOwnerMatch(
  storedOwnerId: string | null | undefined,
  expectedOwnerId?: string | null,
): boolean {
  if (expectedOwnerId === undefined) return true;
  const expected = expectedOwnerId ?? null;
  if (storedOwnerId === undefined) {
    return expected === null;
  }
  return storedOwnerId === expected;
}

export function clearProfileStorage(storageKey: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(storageKey);
  } catch (error) {
    console.warn("Failed to clear profile storage", error);
  }
}
