class CacheService {
  private get api() {
    if (typeof window === "undefined") return undefined;
    return window.electronAPI?.cache;
  }

  isAvailable(): boolean {
    return Boolean(this.api);
  }

  async getImagePath(key: string): Promise<string | null> {
    if (!this.api) return null;
    return this.api.getImagePath(key);
  }

  async saveImage(key: string, data: ArrayBuffer | Uint8Array): Promise<string | null> {
    if (!this.api) return null;
    return this.api.saveImage(key, data);
  }

  async clear(): Promise<void> {
    if (!this.api) return;
    await this.api.clear();
  }
}

export async function hashKey(value: string): Promise<string> {
  if (typeof value !== "string" || !value.length) return "";
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(value);
      const digest = await crypto.subtle.digest("SHA-1", data);
      const bytes = new Uint8Array(digest);
      return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      // fallback ниже
    }
  }
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

const cacheService = new CacheService();
export default cacheService;
