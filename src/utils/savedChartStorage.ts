// src/utils/savedChartStorage.ts

import { useChartCache } from "../store/chartCache";

export const SAVED_CHART_KEY = "synastry_saved_chart_data";

const CACHE_META_FIELD = "__cacheMeta";
const META_SOURCES = new Set(["local", "file", "cloud"] as const);

export type SavedChartSource = "local" | "file" | "cloud";

export interface SavedChartMetadata {
  source: SavedChartSource;
  updatedAt: number;
  fingerprint: string | null;
}

export interface SavedChartRecord<T = Record<string, unknown>> {
  ownerId: string | null | undefined;
  payload: T | null;
  raw: unknown;
  meta: SavedChartMetadata | null;
}

export type SavedChartWriteOptions = {
  meta?: Partial<SavedChartMetadata> | null;
  extra?: Record<string, unknown>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveCacheRecord = (payload: unknown): {
  profile: Record<string, unknown> | null;
  chart: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
} => {
  if (!isPlainObject(payload)) {
    return { profile: null, chart: null, meta: null };
  }
  const profileCandidate = payload.profile;
  const chartCandidate = payload.chart;
  const metaCandidate = payload.meta;
  return {
    profile: isPlainObject(profileCandidate) ? profileCandidate : null,
    chart: isPlainObject(chartCandidate) ? chartCandidate : null,
    meta: isPlainObject(metaCandidate) ? metaCandidate : null,
  };
};

const syncChartCacheStore = (ownerId: string | null | undefined, payload: unknown) => {
  try {
    const { setCache, clear } = useChartCache.getState();
    if (!payload || !isPlainObject(payload)) {
      clear();
      return;
    }
    const { profile, chart, meta } = resolveCacheRecord(payload);
    setCache({ ownerId: ownerId ?? null, profile, chart, meta });
  } catch (error) {
    console.warn("Failed to sync chart cache store", error);
  }
};

const pickMetadata = (value: unknown): SavedChartMetadata | null => {
  if (!isPlainObject(value)) return null;
  const metaValue = value[CACHE_META_FIELD];
  if (!isPlainObject(metaValue)) return null;
  const sourceRaw = metaValue.source;
  const updatedRaw = metaValue.updatedAt;
  const fingerprintRaw = metaValue.fingerprint;
  if (typeof sourceRaw !== "string" || !META_SOURCES.has(sourceRaw as SavedChartSource)) {
    return null;
  }
  if (typeof updatedRaw !== "number" || !Number.isFinite(updatedRaw)) {
    return null;
  }
  let fingerprint: string | null = null;
  if (typeof fingerprintRaw === "string") {
    fingerprint = fingerprintRaw;
  } else if (fingerprintRaw === null) {
    fingerprint = null;
  }

  return {
    source: sourceRaw as SavedChartSource,
    updatedAt: updatedRaw,
    fingerprint,
  };
};

const buildMetadata = (
  partial?: Partial<SavedChartMetadata> | null,
  fallback?: SavedChartMetadata | null,
): SavedChartMetadata => {
  const sourceFallback = fallback?.source ?? "local";
  const updatedFallback = fallback?.updatedAt ?? Date.now();
  const fingerprintFallback = fallback?.fingerprint ?? null;

  const source = partial?.source && META_SOURCES.has(partial.source)
    ? partial.source
    : sourceFallback;
  const updatedAt = typeof partial?.updatedAt === "number" && Number.isFinite(partial.updatedAt)
    ? partial.updatedAt
    : updatedFallback;
  const fingerprint =
    partial?.fingerprint === null
      ? null
      : typeof partial?.fingerprint === "string"
        ? partial.fingerprint
        : fingerprintFallback;

  return { source, updatedAt, fingerprint };
};

const assignMetadata = (target: unknown, meta: SavedChartMetadata | null) => {
  if (!meta || !isPlainObject(target)) return;
  target[CACHE_META_FIELD] = meta;
};

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

    const payloadMeta = pickMetadata(payload ?? parsed);
    const record = { ownerId, payload, raw: parsed, meta: payloadMeta };
    syncChartCacheStore(ownerId, (payload ?? parsed) as unknown);
    return record;
  } catch (e) {
    console.warn("Failed to parse saved chart record", e);
    return null;
  }
}

export function writeSavedChart<T = Record<string, unknown>>(
  payload: T,
  ownerId?: string | null,
  options?: SavedChartWriteOptions,
): void {
  if (!isBrowser()) return;
  try {
    const extraPayload = options?.extra;
    const base = isPlainObject(extraPayload) ? { ...extraPayload } : {};
    const normalizedPayload: unknown = isPlainObject(payload) ? { ...payload } : payload;
    if (isPlainObject(normalizedPayload)) {
      delete normalizedPayload.ownerId;
    }

    const existingMeta = options?.meta
      ? buildMetadata(options.meta)
      : pickMetadata(normalizedPayload) ?? (ownerId !== undefined ? readSavedChart(ownerId ?? null)?.meta ?? null : null);
    const resolvedMeta = existingMeta ?? buildMetadata();
    assignMetadata(normalizedPayload, resolvedMeta);
    assignMetadata(base, resolvedMeta);

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
    syncChartCacheStore(ownerId ?? null, record);
  } catch (error) {
    console.warn("Failed to write saved chart record", error);
  }
}

export function clearSavedChart() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(SAVED_CHART_KEY);
  try {
    useChartCache.getState().clear();
  } catch (error) {
    console.warn("Failed to reset chart cache store", error);
  }
}

export function isSavedChartForUser(expectedOwnerId?: string | null): boolean {
  return Boolean(readSavedChart(expectedOwnerId));
}

export function getSavedChartMetadata(record: SavedChartRecord | null | undefined): SavedChartMetadata | null {
  return record?.meta ?? null;
}
