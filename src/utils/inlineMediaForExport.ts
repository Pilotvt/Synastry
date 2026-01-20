import { resolveSupabaseScreenshotUrl } from "./screenshotUrl";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInlineDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

export async function inlineImageValueForExport(value: string | null | undefined): Promise<string | null> {
  if (!isNonEmptyString(value)) return null;
  const trimmed = value.trim();
  if (isInlineDataUrl(trimmed)) return trimmed;

  let url = trimmed;
  try {
    const maybeResolved = await resolveSupabaseScreenshotUrl(url);
    if (isNonEmptyString(maybeResolved)) {
      url = maybeResolved.trim();
    }
  } catch {
    // ignore
  }

  if (!/^https?:\/\//i.test(url) && !url.startsWith("blob:")) {
    return null;
  }

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await blobToDataUrl(blob);
    return isNonEmptyString(dataUrl) ? dataUrl : null;
  } catch (error) {
    console.warn("Failed to inline image for export", error);
    return null;
  }
}

export async function inlineProfilePhotosForExport<T extends Record<string, unknown>>(profile: T): Promise<T> {
  const next: Record<string, unknown> = { ...profile };

  const mainPhoto = isNonEmptyString(next.mainPhoto) ? next.mainPhoto : null;
  const inlinedMain = await inlineImageValueForExport(mainPhoto as string | null);
  if (inlinedMain) {
    next.mainPhoto = inlinedMain;
  }

  const small = Array.isArray(next.smallPhotos) ? next.smallPhotos : null;
  if (small) {
    const out: (string | null)[] = [];
    for (const item of small) {
      const raw = isNonEmptyString(item) ? String(item).trim() : null;
      const inlined = await inlineImageValueForExport(raw);
      out.push(inlined ?? raw);
    }
    next.smallPhotos = out;
  }

  return next as T;
}

