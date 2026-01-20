import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const BUCKET = process.env.PROFILE_PHOTOS_BUCKET || "profile-photos";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || "100");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isDataUrl = (v) => typeof v === "string" && v.startsWith("data:");
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

function parseDataUrlMime(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : null;
}

function extFromMime(mime) {
  if (!mime) return "bin";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "bin";
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function ensureBucketExists() {
  try {
    const { data, error } = await supabase.storage.getBucket(BUCKET);
    if (!error && data) return true;
  } catch {
    // ignore
  }
  try {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error) {
      console.warn(`Failed to create bucket '${BUCKET}':`, error);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Failed to ensure bucket '${BUCKET}' exists:`, error);
    return false;
  }
}

async function uploadUserPhoto({ userId, kind, index, dataUrl }) {
  const mime = parseDataUrlMime(dataUrl);
  const ext = extFromMime(mime);
  const indexSuffix = kind === "small" ? `-${index}` : "";
  const path = `profiles/${userId}/${kind}${indexSuffix}.${ext}`;
  const blob = await dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    upsert: true,
    contentType: mime || undefined,
  });
  if (error) {
    throw error;
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const publicUrl = data?.publicUrl;
  return { publicUrl, storagePointer: `supabase://${BUCKET}/${path}` };
}

function parseSupabasePointer(pointer) {
  const raw = String(pointer || "").trim();
  if (!raw.startsWith("supabase://")) return null;
  const without = raw.slice("supabase://".length);
  const firstSlash = without.indexOf("/");
  if (firstSlash <= 0) return null;
  const bucket = without.slice(0, firstSlash);
  const path = without.slice(firstSlash + 1);
  return bucket && path ? { bucket, path } : null;
}

function parsePublicObjectUrl(url) {
  const raw = String(url || "").trim();
  if (!raw.startsWith("http")) return null;
  const marker = "/storage/v1/object/public/";
  const idx = raw.indexOf(marker);
  if (idx < 0) return null;
  const rest = raw.slice(idx + marker.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1));
  return bucket && path ? { bucket, path } : null;
}

function parseStorageLocation(value) {
  if (!isNonEmptyString(value)) return null;
  return parseSupabasePointer(value) || parsePublicObjectUrl(value);
}

function encodePath(path) {
  return String(path)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function renderPublicImageUrl({ bucket, path, width, height, resize, quality, format }) {
  const base = String(SUPABASE_URL).replace(/\/+$/, "");
  const encoded = encodePath(path);
  const q = new URLSearchParams();
  q.set("width", String(width));
  q.set("height", String(height));
  q.set("resize", String(resize));
  q.set("quality", String(quality));
  if (format && format !== "origin") {
    q.set("format", String(format));
  } else if (format === "origin") {
    // Omit for compatibility (some deployments default to origin).
  }
  return `${base}/storage/v1/render/image/public/${bucket}/${encoded}?${q.toString()}`;
}

async function uploadMainThumbFromStorage({ userId, source }) {
  const formats = String(process.env.THUMB_FORMATS || "webp,jpeg,png,origin")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const extForFormat = (format) => {
    if (format === "webp") return "webp";
    if (format === "png") return "png";
    if (format === "jpeg" || format === "jpg") return "jpg";
    if (format === "origin") return "jpg";
    return "jpg";
  };
  const contentTypeForExt = (ext) => {
    if (ext === "webp") return "image/webp";
    if (ext === "png") return "image/png";
    return "image/jpeg";
  };

  let lastError = null;
  for (const format of formats) {
    const ext = extForFormat(format);
    const destPath = `profiles/${userId}/main_thumb.${ext}`;
    try {
      const renderUrl = renderPublicImageUrl({
        bucket: source.bucket,
        path: source.path,
        width: 100,
        height: 140,
        resize: "cover",
        quality: 70,
        format,
      });
      const res = await fetch(renderUrl);
      if (!res.ok) {
        throw new Error(`Render failed (${res.status}): ${await res.text()}`);
      }
      const blob = await res.blob();
      const { error } = await supabase.storage.from(BUCKET).upload(destPath, blob, {
        upsert: true,
        contentType: contentTypeForExt(ext),
      });
      if (error) throw error;
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(destPath);
      const publicUrl = data?.publicUrl;
      return { publicUrl, storagePointer: `supabase://${BUCKET}/${destPath}` };
    } catch (e) {
      lastError = e;
      const msg = String(e?.message ?? e);
      if (/querystring\/format/i.test(msg)) continue;
    }
  }
  throw lastError ?? new Error("Failed to generate main thumb");
}

async function run() {
  const okBucket = await ensureBucketExists();
  if (!okBucket) {
    console.warn(`Bucket '${BUCKET}' is not available. Create it in Supabase Storage (public read) and rerun.`);
  }

  let offset = 0;
  let processed = 0;
  let migrated = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from("profiles")
      .select("id,data")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      processed += 1;
      const userId = row.id;
      const data = isRecord(row.data) ? row.data : {};

      const next = { ...data };
      let touched = false;

      if (isDataUrl(next.mainPhoto)) {
        try {
          const uploaded = await uploadUserPhoto({ userId, kind: "main", index: 0, dataUrl: next.mainPhoto });
          next.mainPhoto = uploaded.publicUrl;
          next.mainPhotoStoragePointer = uploaded.storagePointer;
          touched = true;
        } catch (e) {
          console.warn("Failed to migrate mainPhoto", userId, e);
        }
      }

      // Ensure mainPhotoThumb exists (uses Storage render endpoint to generate a small webp)
      if (!isNonEmptyString(next.mainPhotoThumb) && isNonEmptyString(next.mainPhoto)) {
        try {
          const loc =
            parseStorageLocation(next.mainPhotoStoragePointer) ||
            parseStorageLocation(next.mainPhoto);
          if (loc) {
            const thumb = await uploadMainThumbFromStorage({ userId, source: loc });
            if (thumb?.publicUrl) {
              next.mainPhotoThumb = thumb.publicUrl;
              next.mainPhotoThumbStoragePointer = thumb.storagePointer;
              touched = true;
            }
          }
        } catch (e) {
          console.warn("Failed to migrate mainPhoto thumb", userId, e);
        }
      }

      if (Array.isArray(next.smallPhotos)) {
        const pointers = Array.isArray(next.smallPhotosStoragePointers) ? [...next.smallPhotosStoragePointers] : [];
        const updatedSmall = [...next.smallPhotos];
        for (let i = 0; i < updatedSmall.length; i++) {
          if (!isDataUrl(updatedSmall[i])) continue;
          try {
            const uploaded = await uploadUserPhoto({ userId, kind: "small", index: i, dataUrl: updatedSmall[i] });
            updatedSmall[i] = uploaded.publicUrl;
            pointers[i] = uploaded.storagePointer;
            touched = true;
          } catch (e) {
            console.warn("Failed to migrate smallPhoto", userId, i, e);
          }
        }
        if (touched) {
          next.smallPhotos = updatedSmall;
          next.smallPhotosStoragePointers = pointers;
        }
      }

      if (!touched) continue;

      try {
        const { error: updateError } = await supabase.from("profiles").update({ data: next }).eq("id", userId);
        if (updateError) {
          console.warn("Failed to update profile data after migration", userId, updateError);
          continue;
        }
        migrated += 1;
      } catch (e) {
        console.warn("Unexpected update error", userId, e);
      }
    }

    offset += rows.length;
    console.log(`Scanned ${processed}, migrated ${migrated} (offset=${offset})`);
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`Done. Scanned ${processed}, migrated ${migrated}.`);
}

run().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
