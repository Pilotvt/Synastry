from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image
from PIL import ImageFilter
from PIL import ImageEnhance
from PIL import ImageOps
from PIL import ImageDraw
from PIL import ImageChops
from PIL import ImageStat


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0
    t = _clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def _make_craters(seed: int, count: int = 28):
    rng = random.Random(seed)
    craters = []
    for _ in range(count):
        # position on disc (unit circle)
        for _attempt in range(50):
            x = rng.uniform(-0.85, 0.85)
            y = rng.uniform(-0.85, 0.85)
            if x * x + y * y <= 0.85 * 0.85:
                break
        r = rng.uniform(0.06, 0.20)
        depth = rng.uniform(0.04, 0.12)
        craters.append((x, y, r, depth))
    return craters


def _try_load_base_moon_texture(root: Path, size: int) -> Image.Image | None:
    """
    Optional: put a high-quality Moon photo/texture into:
      scripts/assets/moon_base.png (or .jpg/.jpeg/.webp)

    The generator will use it as albedo (craters/relief) and apply lighting/shadow on top.
    """
    assets_dir = root / "scripts" / "assets"
    for name in ("moon_base.png", "moon_base.jpg", "moon_base.jpeg", "moon_base.webp"):
        path = assets_dir / name
        if not path.exists():
            continue
        src = Image.open(path)
        rgba = src.convert("RGBA")
        w, h = rgba.size

        alpha = rgba.getchannel("A")
        # Use alpha bbox when available (for PNG with transparent background).
        alpha_mask = alpha.point(lambda a: 255 if a > 16 else 0)
        bbox = alpha_mask.getbbox()

        # If alpha bbox covers the full image (fully opaque), try luminance threshold
        # to find the moon disc (useful for JPG/opaque PNG with black background).
        if bbox is None or (bbox[0] == 0 and bbox[1] == 0 and bbox[2] == w and bbox[3] == h):
            lum = rgba.convert("L")
            lum_mask = lum.point(lambda p: 255 if p > 20 else 0)
            lum_bbox = lum_mask.getbbox()
            if lum_bbox is not None:
                lw = lum_bbox[2] - lum_bbox[0]
                lh = lum_bbox[3] - lum_bbox[1]
                # Only trust luminance bbox if it is meaningfully smaller than the full image.
                if lw < w * 0.98 or lh < h * 0.98:
                    bbox = lum_bbox

        if bbox is None:
            # Fallback: simple center-crop square.
            s = min(w, h)
            left = (w - s) // 2
            top = (h - s) // 2
            cropped = rgba.crop((left, top, left + s, top + s))
        else:
            pad = max(2, int(0.02 * max(w, h)))
            left = max(0, bbox[0] - pad)
            top = max(0, bbox[1] - pad)
            right = min(w, bbox[2] + pad)
            bottom = min(h, bbox[3] + pad)
            cropped = rgba.crop((left, top, right, bottom))

        cw, ch = cropped.size
        s = max(cw, ch)
        square = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        square.paste(cropped, ((s - cw) // 2, (s - ch) // 2), cropped)

        if square.size != (size, size):
            # Resize with premultiplied alpha to avoid dark fringes bleeding into the disc.
            square = _premultiply_alpha(square).resize((size, size), Image.Resampling.LANCZOS)
            square = _unpremultiply_alpha_strict(square)
        return square
    return None


def _make_procedural_texture(size: int, seed: int) -> Image.Image:
    """
    Fast deterministic crater-like texture (grayscale) used when no base photo is provided.
    Output is an "albedo" texture only; lighting is applied later.
    """
    # Base noise (cheap) + blur to look like lunar maria
    noise = Image.effect_noise((size, size), sigma=42.0).convert("L")
    noise = noise.filter(ImageFilter.GaussianBlur(radius=max(1, size // 220)))
    noise = ImageEnhance.Contrast(noise).enhance(1.35)

    # Crater mask (darker spots)
    crater = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(crater)
    for (x, y, r, depth) in _make_craters(seed, count=34):
        cx = int((x * 0.5 + 0.5) * (size - 1))
        cy = int((y * 0.5 + 0.5) * (size - 1))
        rad = max(1, int(r * (size * 0.5)))
        val = int(255 * depth)
        draw.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=val)
    crater = crater.filter(ImageFilter.GaussianBlur(radius=max(1, size // 320)))

    # Combine: start from noise as 0..255, subtract craters a bit.
    # Clamp via ImageOps.autocontrast at the end.
    combined = ImageChops.subtract(noise, crater, scale=1.6, offset=28)
    combined = ImageOps.autocontrast(combined, cutoff=2)
    combined = ImageEnhance.Contrast(combined).enhance(1.15)
    return combined


def _prepare_texture_map(root: Path, size: int, seed: int) -> Image.Image:
    base = _try_load_base_moon_texture(root, size)
    if base is None:
        return _make_procedural_texture(size=size, seed=seed)
    # We build an albedo map from the base photo, but remove its radial limb shading.
    # Otherwise the photo's own edge darkening/highlights show up as a visible rim.
    if base.mode != "RGBA":
        base = base.convert("RGBA")
    alpha = base.getchannel("A")
    tex = base.convert("L")

    mask = alpha.point(lambda a: 255 if a > 16 else 0)
    mean_val = float(ImageStat.Stat(tex, mask=mask).mean[0])

    w, h = tex.size
    cx = (w - 1) / 2.0
    cy = (h - 1) / 2.0

    # Estimate disc radius from the alpha mask (scan right from center).
    mask_px = mask.load()
    r_px = min(w, h) / 2.0
    center_y = int(round(cy))
    for x in range(int(round(cx)), w):
        if mask_px[x, center_y] == 0:
            r_px = max(1.0, (x - cx) - 1.0)
            break

    bins = 256
    sums = [0.0] * bins
    counts = [0] * bins
    tex_px = tex.load()
    for y in range(h):
        dy = y - cy
        for x in range(w):
            if mask_px[x, y] == 0:
                continue
            dx = x - cx
            r = math.sqrt(dx * dx + dy * dy) / r_px
            if r > 1.0:
                continue
            bi = min(bins - 1, int(r * (bins - 1)))
            sums[bi] += tex_px[x, y]
            counts[bi] += 1

    profile = [mean_val] * bins
    last = mean_val
    for i in range(bins):
        if counts[i] > 0:
            last = sums[i] / counts[i]
        profile[i] = last

    out = Image.new("L", (w, h), int(mean_val))
    out_px = out.load()
    for y in range(h):
        dy = y - cy
        for x in range(w):
            if mask_px[x, y] == 0:
                out_px[x, y] = int(mean_val)
                continue
            dx = x - cx
            r = math.sqrt(dx * dx + dy * dy) / r_px
            if r > 1.0:
                out_px[x, y] = int(mean_val)
                continue
            bi = min(bins - 1, int(r * (bins - 1)))
            denom = profile[bi] if profile[bi] > 1e-6 else mean_val
            val = int(_clamp01((tex_px[x, y] * mean_val) / denom / 255.0) * 255.0)
            out_px[x, y] = val

    # Enhance crater visibility without introducing a rim: we operate on an image where
    # the outside of the disc is filled with mean brightness, so edge filtering is stable.
    out = ImageEnhance.Contrast(out).enhance(1.25)
    out = out.filter(ImageFilter.UnsharpMask(radius=max(1, size // 420), percent=140, threshold=2))
    out = ImageOps.autocontrast(out, cutoff=1)
    return out


def render_moon_icon(
    size: int,
    elongation_deg: float,
    texture_seed: int = 1337,
    *,
    flip_after_full: bool = False,
    texture_map: Image.Image,
) -> Image.Image:
    """
    Render a moon phase disk with transparent background.

    elongation_deg: (Moon_lon - Sun_lon) in degrees, 0=new, 180=full.
    flip_after_full: if True, mirrors the light direction after full moon (tithi 16+),
      forcing the bright limb to stay on the same side. Default is False (physical waxing/waning).
    base_texture: optional, already resized to (size,size).
    """

    # Keep a consistent transparent padding around the disc so the final downscaled
    # icon does not touch the image border (which would create a visible fringe in viewers).
    pad = max(2, size // 60)  # 720->12, 240->4
    r_px = (size - 2 * pad) / 2.0
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0

    # Convert elongation (Moon_lon - Sun_lon) to a sun direction in the x-z plane.
    # We model the observer looking along +z.
    #
    # phase = 0 deg  -> new moon  (sun from behind the disc):  sx=0,  sz=-1
    # phase = 90 deg -> waxing half (light from right):        sx=+1, sz=0
    # phase = 180 deg-> full moon (sun behind observer):       sx=0,  sz=+1
    # phase = 270 deg-> waning half (light from left):         sx=-1, sz=0
    phase_deg = elongation_deg % 360.0
    phase = math.radians(phase_deg)
    sx = math.sin(phase)
    sz = -math.cos(phase)
    if flip_after_full and phase_deg > 180.0:
        sx = -sx

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    tex_px = texture_map.load()

    shadow_ambient = 0.04
    lit_gain = 0.96
    terminator_soft = 0.10  # smaller = sharper; slightly blur the boundary
    # Force a neutral albedo near the limb to eliminate any remaining "rim" coming
    # from the source photo / enhancement filters.
    limb_fade_start = 0.90
    limb_fade_end = 0.995
    limb_albedo_target = 0.60

    x_norm = [(ix - cx) / r_px for ix in range(size)]
    xx = [v * v for v in x_norm]
    y_norm = [(iy - cy) / r_px for iy in range(size)]
    yy = [v * v for v in y_norm]

    for iy in range(size):
        y = y_norm[iy]
        for ix in range(size):
            x = x_norm[ix]
            rr = xx[ix] + yy[iy]
            r = math.sqrt(max(0.0, rr))
            if r >= 1.0:
                continue

            alpha = 255

            z = math.sqrt(max(0.0, 1.0 - rr))

            # Albedo texture (normalized to remove the photo's limb shading).
            tex = tex_px[ix, iy] / 255.0
            albedo = _clamp01(0.08 + tex * 0.92)
            edge = _smoothstep(limb_fade_start, limb_fade_end, r)
            albedo = _clamp01(albedo * (1.0 - edge) + limb_albedo_target * edge)

            # Slightly blurred terminator, but keep the lit side fully lit (no "rim" on full moon).
            dot = x * sx + z * sz
            lit = _smoothstep(-terminator_soft, 0.0, dot)
            intensity = shadow_ambient + lit_gain * lit

            # Gentle contrast without overexposure.
            intensity = intensity**0.92

            v = _clamp01(albedo * intensity)
            c = int(255 * v)
            px[ix, iy] = (c, c, c, alpha)

    return img


def _apply_hard_circle_alpha(img: Image.Image, *, pad: int, shrink_px: float = 0.0) -> Image.Image:
    """
    Remove any anti-aliased fringe around the moon disc by enforcing a hard
    circle alpha (0/255). This matches the user's request: no visible rim/outline
    on any background.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    w, h = img.size
    cx = (w - 1) / 2.0
    cy = (h - 1) / 2.0
    r_px = (min(w, h) - 2 * pad) / 2.0 - float(shrink_px)
    if r_px < 1.0:
        r_px = 1.0
    r2 = r_px * r_px
    src = img.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dst = out.load()
    for y in range(h):
        dy = y - cy
        for x in range(w):
            dx = x - cx
            if dx * dx + dy * dy <= r2:
                r, g, b, _a = src[x, y]
                dst[x, y] = (r, g, b, 255)
    return out


def _premultiply_alpha(img: Image.Image) -> Image.Image:
    r, g, b, a = img.split()
    r = ImageChops.multiply(r, a)
    g = ImageChops.multiply(g, a)
    b = ImageChops.multiply(b, a)
    return Image.merge("RGBA", (r, g, b, a))


def _unpremultiply_alpha(img: Image.Image) -> Image.Image:
    r, g, b, a = img.split()
    rp = r.load()
    gp = g.load()
    bp = b.load()
    ap = a.load()
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out_px = out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            aa = ap[x, y]
            if aa == 0 or aa < 6:
                out_px[x, y] = (0, 0, 0, 0)
                continue

            # Unpremultiply (for PNG we want non-premultiplied RGB).
            rr = min(255, int(rp[x, y] * 255 / aa))
            gg = min(255, int(gp[x, y] * 255 / aa))
            bb = min(255, int(bp[x, y] * 255 / aa))
            out_px[x, y] = (rr, gg, bb, aa)
    return out


def _unpremultiply_alpha_strict(img: Image.Image) -> Image.Image:
    r, g, b, a = img.split()
    rp = r.load()
    gp = g.load()
    bp = b.load()
    ap = a.load()
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out_px = out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            aa = ap[x, y]
            if aa == 0:
                out_px[x, y] = (0, 0, 0, 0)
                continue
            out_px[x, y] = (
                min(255, int(rp[x, y] * 255 / aa)),
                min(255, int(gp[x, y] * 255 / aa)),
                min(255, int(bp[x, y] * 255 / aa)),
                aa,
            )
    return out


def tithi_to_elongation_center(tithi: int) -> float:
    if tithi == 15:
        return 180.0
    if tithi == 30:
        return 0.0
    return ((tithi - 0.5) * 12.0) % 360.0


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out_dir = root / "public" / "moon"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Render bigger than UI size to look crisp on HiDPI screens (UI displays 120x120).
    out_size = 240
    render_size = 720  # supersampling improves crater detail

    texture_map = _prepare_texture_map(root, render_size, seed=1337)

    for tithi in range(1, 31):
        elong = tithi_to_elongation_center(tithi)
        img = render_moon_icon(
            size=render_size,
            elongation_deg=elong,
            texture_seed=1337,
            flip_after_full=False,
            texture_map=texture_map,
        )
        # NOTE: Don't sharpen the final rendered image: it creates a visible halo on the disc edge.
        img = _premultiply_alpha(img).resize((out_size, out_size), Image.Resampling.LANCZOS)
        img = _unpremultiply_alpha(img)
        img = _apply_hard_circle_alpha(img, pad=max(2, out_size // 60), shrink_px=1.5)
        out_path = out_dir / f"tithi-{tithi:02d}.png"
        img.save(out_path, format="PNG", optimize=True)
        print("wrote", out_path)


if __name__ == "__main__":
    main()
