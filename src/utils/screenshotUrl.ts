import { supabase } from "../lib/supabase";

export type SupabaseStoragePointer = {
  bucket: string;
  path: string;
};

const STORAGE_PUBLIC_SEGMENT = "/storage/v1/object/";

function sanitizePath(path: string): string {
  return path.replace(/^\/+/, "");
}

export function parseSupabaseStoragePointer(raw: string | null | undefined): SupabaseStoragePointer | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.startsWith("supabase://")) {
    const pointer = raw.slice("supabase://".length);
    const slashIdx = pointer.indexOf("/");
    if (slashIdx === -1) return null;
    const bucket = pointer.slice(0, slashIdx);
    const path = sanitizePath(pointer.slice(slashIdx + 1));
    if (!bucket || !path) return null;
    return { bucket, path };
  }

  try {
    const url = new URL(raw);
    if (!url.pathname.includes(STORAGE_PUBLIC_SEGMENT)) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const objectIndex = parts.findIndex((segment) => segment === "object");
    if (objectIndex === -1 || parts.length <= objectIndex + 2) {
      return null;
    }
    const bucket = parts[objectIndex + 2];
    const pointerSegments = parts.slice(objectIndex + 3);
    if (!bucket || pointerSegments.length === 0) {
      return null;
    }
    const path = sanitizePath(pointerSegments.join("/"));
    if (!path) return null;
    return { bucket, path };
  } catch {
    return null;
  }
}

export function encodeSupabasePointer(pointer: SupabaseStoragePointer): string {
  return `supabase://${pointer.bucket}/${pointer.path}`;
}

export function needsSupabaseResolution(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (raw.startsWith("data:")) return false;
  if (raw.startsWith("blob:")) return false;
  if (raw.startsWith("supabase://")) return true;
  return /\/storage\/v1\/object\//.test(raw);
}

export async function resolveSupabaseScreenshotUrl(
  raw: string | null | undefined,
  expiresInSeconds = 60 * 60 * 24,
): Promise<string | null> {
  if (!raw) return null;
  const pointer = parseSupabaseStoragePointer(raw);
  if (!pointer) {
    return raw;
  }
  try {
    const { data, error } = await supabase
      .storage
      .from(pointer.bucket)
      .createSignedUrl(pointer.path, Math.min(expiresInSeconds, 60 * 60 * 24 * 6));
    if (!error && data?.signedUrl) {
      return data.signedUrl;
    }
  } catch (err) {
    console.warn("Failed to create signed screenshot URL", err);
  }
  try {
    const { data } = supabase.storage.from(pointer.bucket).getPublicUrl(pointer.path);
    if (data?.publicUrl) {
      return data.publicUrl;
    }
  } catch (err) {
    console.warn("Failed to read public screenshot URL", err);
  }
  return raw;
}
