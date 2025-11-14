const resolveOwner = (value: unknown): string | null | undefined => {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return undefined;
};

export function readProfileFromStorage<T>(
  storageKey: string,
  expectedOwnerId?: string | null,
): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ownerId?: string | null; profile?: T };
    const storedOwner = resolveOwner(parsed?.ownerId);
    if (expectedOwnerId !== undefined) {
      if (storedOwner !== undefined) {
        if (!expectedOwnerId && storedOwner) {
          return null;
        }
        if (expectedOwnerId && storedOwner !== expectedOwnerId) {
          return null;
        }
      } else if (expectedOwnerId) {
        return null;
      }
    }
    const profile = parsed && typeof parsed === "object" && "profile" in parsed
      ? (parsed.profile as T | undefined)
      : undefined;
    return (profile ?? (parsed as unknown as T)) ?? null;
  } catch (error) {
    console.warn("Failed to read profile from storage", error);
    return null;
  }
}

export function writeProfileToStorage<T>(
  storageKey: string,
  snapshot: T,
  ownerId?: string | null,
  mergeExisting = true,
) {
  if (typeof window === "undefined") return;
  try {
    const existingRaw = mergeExisting ? localStorage.getItem(storageKey) : null;
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const payload = { ...existing, ownerId: ownerId ?? null, profile: snapshot };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to persist profile snapshot", error);
  }
}

export function clearProfileStorage(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch (error) {
    console.warn("Failed to clear profile storage", error);
  }
}
