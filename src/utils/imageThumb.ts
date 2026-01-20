type FitMode = "cover" | "contain";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function createThumbDataUrlFromSource(
  source: string,
  params: {
    width: number;
    height: number;
    fit: FitMode;
    mimeType?: "image/webp" | "image/jpeg" | "image/png";
    quality?: number;
    background?: string | null;
  },
): Promise<string | null> {
  const width = Math.max(1, Math.round(params.width));
  const height = Math.max(1, Math.round(params.height));
  const fit = params.fit;
  const mimeType = params.mimeType ?? "image/webp";
  const quality = clamp01(typeof params.quality === "number" ? params.quality : 0.72);
  const background = params.background ?? null;

  const url = source.startsWith("data:") || source.startsWith("blob:") ? source : String(source);
  let img: HTMLImageElement;
  try {
    img = await loadImageFromUrl(url);
  } catch (error) {
    console.warn("Failed to load image for thumbnail", error);
    return null;
  }

  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  let dx = 0;
  let dy = 0;
  let dw = width;
  let dh = height;

  if (fit === "contain") {
    const scale = Math.min(width / sw, height / sh);
    dw = Math.max(1, Math.round(sw * scale));
    dh = Math.max(1, Math.round(sh * scale));
    dx = Math.round((width - dw) / 2);
    dy = Math.round((height - dh) / 2);
  } else {
    const scale = Math.max(width / sw, height / sh);
    dw = Math.max(1, Math.round(sw * scale));
    dh = Math.max(1, Math.round(sh * scale));
    dx = Math.round((width - dw) / 2);
    dy = Math.round((height - dh) / 2);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, dx, dy, dw, dh);

  try {
    return canvas.toDataURL(mimeType, quality);
  } catch (error) {
    console.warn("Failed to export thumbnail", error);
    return null;
  }
}

