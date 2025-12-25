# Moon base texture (optional)

If you want *photorealistic* Moon phase icons (real craters/relief), put a square Moon photo/texture here:

- `scripts/assets/moon_base.png` (preferred)
- or `scripts/assets/moon_base.jpg` / `moon_base.jpeg` / `moon_base.webp`

Then regenerate icons:

```bash
python scripts/generate_tithi_moon_icons.py
```

Notes:
- The generator will center-crop the image to a square and resize it.
- Make sure you have the rights to use the image (public domain / your own / properly licensed).
