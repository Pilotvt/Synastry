"""Проверка размеров тестовых изображений."""
from pathlib import Path
from PIL import Image

test_dir = Path("test_images")

for img_path in test_dir.glob("*.jpg"):
    try:
        img = Image.open(img_path)
        print(f"{img_path.name}: {img.size[0]}x{img.size[1]} px")
    except Exception as e:
        print(f"{img_path.name}: error - {e}")

for img_path in test_dir.glob("*.png"):
    try:
        img = Image.open(img_path)
        print(f"{img_path.name}: {img.size[0]}x{img.size[1]} px")
    except Exception as e:
        print(f"{img_path.name}: error - {e}")
