from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


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


def render_moon_icon(
    size: int,
    elongation_deg: float,
    texture_seed: int = 1337,
) -> Image.Image:
    """
    Render a moon phase disk with transparent background.

    elongation_deg: (Moon_lon - Sun_lon) in degrees, 0=new, 180=full.
    waxing_right: True => illuminated limb on the right (as in the user screenshot).
    """

    r_px = (size - 4) / 2.0
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0

    # Convert elongation (Moon_lon - Sun_lon) to a sun direction in the x-z plane.
    # We model the observer looking along +z.
    #
    # phase = 0°  -> new moon  (sun from behind the disc):  sx=0,  sz=-1
    # phase = 90° -> waxing half (light from right):        sx=+1, sz=0
    # phase = 180°-> full moon (sun behind observer):       sx=0,  sz=+1
    # phase = 270°-> waning half (light from left):         sx=-1, sz=0
    phase = math.radians(elongation_deg % 360.0)
    sx = math.sin(phase)
    sz = -math.cos(phase)

    craters = _make_craters(texture_seed, count=30)

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()

    base = (230, 230, 230)
    shadow_ambient = 0.12
    lit_gain = 0.90

    for iy in range(size):
        y = (iy - cy) / r_px
        for ix in range(size):
            x = (ix - cx) / r_px
            rr = x * x + y * y
            if rr > 1.0:
                continue

            z = math.sqrt(max(0.0, 1.0 - rr))
            # simple albedo texture: limb darkening + craters
            limb = 0.70 + 0.30 * z
            albedo = limb
            for (tx, ty, tr, depth) in craters:
                dx = x - tx
                dy = y - ty
                dr = math.sqrt(dx * dx + dy * dy)
                if dr < tr:
                    # soft crater falloff
                    t = 1.0 - (dr / tr)
                    albedo *= 1.0 - depth * (t * t)

            # diffuse shading from sun (Lambert)
            ndotl = max(0.0, x * sx + z * sz)
            intensity = shadow_ambient + lit_gain * ndotl
            intensity = _clamp01(intensity)

            # slight terminator softness via gamma
            intensity = intensity ** 0.85

            r = int(base[0] * albedo * intensity)
            g = int(base[1] * albedo * intensity)
            b = int(base[2] * albedo * intensity)
            r = 0 if r < 0 else 255 if r > 255 else r
            g = 0 if g < 0 else 255 if g > 255 else g
            b = 0 if b < 0 else 255 if b > 255 else b

            px[ix, iy] = (r, g, b, 255)

    return img


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

    size = 160
    for tithi in range(1, 31):
        elong = tithi_to_elongation_center(tithi)
        img = render_moon_icon(
            size=size,
            elongation_deg=elong,
            texture_seed=1337,
        )
        out_path = out_dir / f"tithi-{tithi:02d}.png"
        img.save(out_path, format="PNG", optimize=True)
        print("wrote", out_path)


if __name__ == "__main__":
    main()
