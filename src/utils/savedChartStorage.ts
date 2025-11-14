// src/utils/savedChartStorage.ts

export const SAVED_CHART_KEY = "synastry_saved_chart_data";

export interface SavedChartRecord<T = Record<string, unknown>> {
  ownerId: string | null | undefined;
  payload: T | null;
  raw: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOwnerId = (value: unknown): string | null | undefined => {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return undefined;
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

const isOwnerMatch = (
  stored: string | null | undefined,
  expected?: string | null,
): boolean => {
  if (expected === undefined) return true;
  const normalizedExpected = expected ?? null;
  if (stored === undefined) {
    return normalizedExpected === null;
  }
  return stored === normalizedExpected;
};

export function readSavedChart<T = Record<string, unknown>>(
  expectedOwnerId?: string | null,
): SavedChartRecord<T> | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(SAVED_CHART_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const ownerId = isPlainObject(parsed) && "ownerId" in parsed
      ? normalizeOwnerId((parsed as Record<string, unknown>).ownerId)
      : undefined;
    if (!isOwnerMatch(ownerId, expectedOwnerId)) {
      return null;
    }

    let payload: T | null = null;
    if (isPlainObject(parsed) && "payload" in parsed) {
      payload = ((parsed as { payload?: unknown }).payload as T | null | undefined) ?? null;
    } else if (isPlainObject(parsed)) {
      payload = parsed as T;
    } else {
      payload = (parsed as T) ?? null;
    }

    return { ownerId, payload, raw: parsed };
  } catch (e) {
    console.warn("Failed to parse saved chart record", e);
    return null;
  }
}

export function writeSavedChart<T = Record<string, unknown>>(
  payload: T,
  ownerId?: string | null,
  extra?: Record<string, unknown>,
): void {
  if (!isBrowser()) return;
  try {
    const base = isPlainObject(extra) ? { ...extra } : {};
    const normalizedPayload: unknown = isPlainObject(payload) ? { ...payload } : payload;
    if (isPlainObject(normalizedPayload)) {
      delete normalizedPayload.ownerId;
    }

    const record: Record<string, unknown> = {
      ...base,
      ownerId: ownerId ?? null,
      payload: normalizedPayload,
    };

    if (isPlainObject(normalizedPayload)) {
      Object.keys(normalizedPayload).forEach((key) => {
        if (key === "ownerId" || key === "payload") return;
        record[key] = (normalizedPayload as Record<string, unknown>)[key];
      });
    }

    // Re-assign ownerId to prevent payload overlays from clobbering it
    record.ownerId = ownerId ?? null;

    window.localStorage.setItem(SAVED_CHART_KEY, JSON.stringify(record));
  } catch (error) {
    console.warn("Failed to write saved chart record", error);
  }
}

export function clearSavedChart() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(SAVED_CHART_KEY);
}

export function isSavedChartForUser(expectedOwnerId?: string | null): boolean {
  return Boolean(readSavedChart(expectedOwnerId));
}
