import { uploadProfilePhotoToStorage } from "./profilePhotoStorage";
import { createThumbDataUrlFromSource } from "./imageThumb";

type AnyProfile = Record<string, unknown>;

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

function normalizeSmallPhotos(value: unknown, max: number): (string | null)[] {
  const src = Array.isArray(value) ? value : [];
  const out: (string | null)[] = src
    .slice(0, max)
    .map((item) => (typeof item === "string" && item.trim() ? item : null));
  while (out.length < max) out.push(null);
  return out;
}

function normalizePointers(value: unknown, max: number): (string | null)[] {
  const src = Array.isArray(value) ? value : [];
  const out: (string | null)[] = src
    .slice(0, max)
    .map((item) => (typeof item === "string" && item.trim() ? item : null));
  while (out.length < max) out.push(null);
  return out;
}

export async function migrateProfilePhotosToStorage<T extends AnyProfile>(params: {
  userId: string;
  profile: T;
  maxSmallPhotos?: number;
}): Promise<{ profile: T; changed: boolean }> {
  const userId = String(params.userId || "").trim();
  if (!userId) return { profile: params.profile, changed: false };

  const maxSmallPhotos = typeof params.maxSmallPhotos === "number" ? params.maxSmallPhotos : 2;
  const profile = params.profile;

  let changed = false;
  const next: AnyProfile = { ...(profile as AnyProfile) };

  const mainPhoto = next.mainPhoto;
  if (isDataUrl(mainPhoto)) {
    const uploaded = await uploadProfilePhotoToStorage({ userId, kind: "main", dataUrl: mainPhoto });
    if (uploaded) {
      next.mainPhoto = uploaded.publicUrl;
      next.mainPhotoStoragePointer = uploaded.storagePointer;
      changed = true;

      try {
        const thumbDataUrl = await createThumbDataUrlFromSource(mainPhoto, {
          width: 100,
          height: 140,
          fit: "cover",
          mimeType: "image/webp",
          quality: 0.7,
          background: null,
        });
        if (thumbDataUrl) {
          const uploadedThumb = await uploadProfilePhotoToStorage({
            userId,
            kind: "main",
            dataUrl: thumbDataUrl,
            variantSuffix: "_thumb",
          });
          if (uploadedThumb) {
            next.mainPhotoThumb = uploadedThumb.publicUrl;
            next.mainPhotoThumbStoragePointer = uploadedThumb.storagePointer;
            changed = true;
          }
        }
      } catch (thumbError) {
        console.warn("Failed to create/upload main photo thumb during migration", thumbError);
      }
    }
  }

  const smallPhotos = normalizeSmallPhotos(next.smallPhotos, maxSmallPhotos);
  const pointers = normalizePointers(next.smallPhotosStoragePointers, maxSmallPhotos);
  for (let idx = 0; idx < maxSmallPhotos; idx += 1) {
    const photo = smallPhotos[idx];
    if (!isDataUrl(photo)) continue;
    const uploaded = await uploadProfilePhotoToStorage({ userId, kind: "small", index: idx, dataUrl: photo });
    if (!uploaded) continue;
    smallPhotos[idx] = uploaded.publicUrl;
    pointers[idx] = uploaded.storagePointer;
    changed = true;
  }
  if (changed) {
    next.smallPhotos = smallPhotos;
    next.smallPhotosStoragePointers = pointers;
  }

  return { profile: next as T, changed };
}
