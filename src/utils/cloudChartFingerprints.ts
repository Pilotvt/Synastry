import { LAST_SAVED_CHART_FINGERPRINT_KEY } from "../constants/storageKeys";

type StoredChartFingerprintsV2 = {
  v: 2;
  keys: string[];
};

const MAX_KEYS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isV2(value: unknown): value is StoredChartFingerprintsV2 {
  if (!isRecord(value)) return false;
  return value.v === 2 && Array.isArray(value.keys) && value.keys.every((k) => typeof k === "string");
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function chartFingerprintKey(fingerprint: string): string | null {
  const trimmed = typeof fingerprint === "string" ? fingerprint.trim() : "";
  if (!trimmed) return null;
  return fnv1a64Hex(trimmed);
}

export function readCloudSavedChartFingerprintKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isV2(parsed)) {
        return new Set(parsed.keys.filter((k) => typeof k === "string" && k.trim()));
      }
    } catch {
      // legacy format: the raw value was the full fingerprint string
    }
    const legacyKey = chartFingerprintKey(raw);
    return legacyKey ? new Set([legacyKey]) : new Set();
  } catch (error) {
    console.warn("Failed to read saved chart fingerprint keys", error);
    return new Set();
  }
}

export function markCloudSavedChartFingerprint(fingerprint: string): void {
  const key = chartFingerprintKey(fingerprint);
  if (!key) return;
  try {
    const existing = readCloudSavedChartFingerprintKeys();
    const next = [key, ...Array.from(existing).filter((k) => k !== key)].slice(0, MAX_KEYS);
    const payload: StoredChartFingerprintsV2 = { v: 2, keys: next };
    localStorage.setItem(LAST_SAVED_CHART_FINGERPRINT_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to persist saved chart fingerprint", error);
  }
}

export function clearCloudSavedChartFingerprints(): void {
  try {
    localStorage.removeItem(LAST_SAVED_CHART_FINGERPRINT_KEY);
  } catch (error) {
    console.warn("Failed to clear saved chart fingerprints", error);
  }
}

