import { supabase } from "../lib/supabase";
import { encodeSupabasePointer } from "./screenshotUrl";

const DEFAULT_BUCKETS = ["profile-photos", "profiles-photos", "avatars", "public"];

function parseDataUrlMime(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : null;
}

function extFromMime(mime: string | null): string {
  if (!mime) return "bin";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "bin";
}

export async function uploadProfilePhotoToStorage(params: {
  userId: string;
  kind: "main" | "small";
  index?: number;
  dataUrl: string;
  buckets?: string[];
  variantSuffix?: string;
}): Promise<{ publicUrl: string; storagePointer: string; bucket: string; path: string } | null> {
  const userId = String(params.userId || "").trim();
  if (!userId) return null;
  const dataUrl = String(params.dataUrl || "");
  if (!dataUrl.startsWith("data:")) return null;

  const buckets = Array.isArray(params.buckets) && params.buckets.length ? params.buckets : DEFAULT_BUCKETS;
  const mime = parseDataUrlMime(dataUrl);
  const ext = extFromMime(mime);
  const indexSuffix = params.kind === "small" && typeof params.index === "number" ? `-${params.index}` : "";
  const variantSuffix = typeof params.variantSuffix === "string" && params.variantSuffix ? params.variantSuffix : "";
  const path = `profiles/${userId}/${params.kind}${indexSuffix}${variantSuffix}.${ext}`;

  let blob: Blob;
  try {
    const res = await fetch(dataUrl);
    blob = await res.blob();
  } catch (error) {
    console.warn("Failed to convert profile photo dataUrl to blob", error);
    return null;
  }

  for (const bucket of buckets) {
    try {
      const { error } = await supabase.storage.from(bucket).upload(path, blob, {
        contentType: mime ?? undefined,
        upsert: true,
      });
      if (error) {
        const msg = String(error);
        if (/bucket/i.test(msg) && /not found|does not exist/i.test(msg)) {
          continue;
        }
        console.warn("Failed to upload profile photo", { bucket, path, error });
        return null;
      }
      const storagePointer = encodeSupabasePointer({ bucket, path });
      const { data } = supabase.storage.from(bucket).getPublicUrl(path);
      const publicUrl = data?.publicUrl ? String(data.publicUrl) : storagePointer;
      return { publicUrl, storagePointer, bucket, path };
    } catch (error) {
      console.warn("Unexpected profile photo upload error", { bucket, path, error });
    }
  }

  return null;
}
