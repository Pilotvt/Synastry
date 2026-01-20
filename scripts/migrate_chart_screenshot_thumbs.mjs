import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const PAGE_SIZE = Number(process.env.PAGE_SIZE || "200");
const THUMB_WIDTH = Number(process.env.THUMB_WIDTH || "220");
const THUMB_HEIGHT = Number(process.env.THUMB_HEIGHT || "160");
const THUMB_QUALITY = Number(process.env.THUMB_QUALITY || "70");
const THUMB_FORMATS = String(process.env.THUMB_FORMATS || "webp,jpeg,png,origin")
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

function encodePath(path) {
  return String(path)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
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
    // Some Supabase deployments accept origin, others default to origin when omitted.
    // Keep it omitted for maximum compatibility.
  }
  return `${base}/storage/v1/render/image/public/${bucket}/${encoded}?${q.toString()}`;
}

function extForFormat(format) {
  if (format === "webp") return "webp";
  if (format === "png") return "png";
  if (format === "jpeg" || format === "jpg") return "jpg";
  if (format === "origin") return "jpg";
  return "jpg";
}

function contentTypeForExt(ext) {
  if (ext === "webp") return "image/webp";
  if (ext === "png") return "image/png";
  return "image/jpeg";
}

async function fetchRenderedThumb({ bucket, sourcePath, format }) {
  const renderUrl = renderPublicImageUrl({
    bucket,
    path: sourcePath,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    resize: "contain",
    quality: THUMB_QUALITY,
    format,
  });
  const res = await fetch(renderUrl);
  if (!res.ok) {
    throw new Error(`Render failed (${res.status}): ${await res.text()}`);
  }
  const blob = await res.blob();
  return blob;
}

async function uploadChartThumb({ bucket, sourcePath }) {
  let lastError = null;
  for (const format of THUMB_FORMATS) {
    try {
      const blob = await fetchRenderedThumb({ bucket, sourcePath, format });
      const ext = extForFormat(format);
      const destPathBase = sourcePath.endsWith(".png")
        ? sourcePath.replace(/\.png$/i, "-thumb")
        : `${sourcePath}-thumb`;
      const destPath = `${destPathBase}.${ext}`;
      const { error } = await supabase.storage.from(bucket).upload(destPath, blob, {
        upsert: true,
        contentType: contentTypeForExt(ext),
      });
      if (error) throw error;
      const { data } = supabase.storage.from(bucket).getPublicUrl(destPath);
      const publicUrl = data?.publicUrl;
      return { publicUrl, storagePointer: `supabase://${bucket}/${destPath}` };
    } catch (e) {
      lastError = e;
      const msg = String(e?.message ?? e);
      if (/querystring\/format/i.test(msg)) {
        continue;
      }
    }
  }
  throw lastError ?? new Error("Failed to render thumbnail with all formats");
}

async function run() {
  let offset = 0;
  let processed = 0;
  let updated = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from("charts")
      .select("id,chart")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      processed += 1;
      const chartId = row.id;
      const chart = isRecord(row.chart) ? row.chart : null;
      if (!chart) continue;

      if (isNonEmptyString(chart.screenshotThumbStoragePointer) || isNonEmptyString(chart.screenshotThumbUrl)) {
        continue;
      }

      const loc =
        parseStorageLocation(chart.screenshotStoragePointer) ||
        parseStorageLocation(chart.screenshotUrl);
      if (!loc) continue;

      try {
        const thumb = await uploadChartThumb({ bucket: loc.bucket, sourcePath: loc.path });
        if (!thumb?.publicUrl) continue;
        const nextChart = {
          ...chart,
          screenshotThumbUrl: thumb.publicUrl,
          screenshotThumbStoragePointer: thumb.storagePointer,
        };
        const { error: updateError } = await supabase.from("charts").update({ chart: nextChart }).eq("id", chartId);
        if (updateError) {
          console.warn("Failed to update chart row", chartId, updateError);
          continue;
        }
        updated += 1;
      } catch (e) {
        console.warn("Failed to create chart screenshot thumb", chartId, e);
      }
    }

    offset += rows.length;
    console.log(`Scanned ${processed}, updated ${updated} (offset=${offset})`);
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`Done. Scanned ${processed}, updated ${updated}.`);
}

run().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
