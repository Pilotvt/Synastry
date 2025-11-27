"""Тест модерации на фотографии мужчины в белье."""
import sys
from pathlib import Path

# Добавляем app в путь
app_path = Path(__file__).parent / "app"
sys.path.insert(0, str(app_path))

# Импорт после добавления в путь
from app.moderation.image import analyze_image


def test_image(image_path: str):
    """Проверить модерацию изображения."""
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    
    print(f"\n{'='*60}")
    print(f"Тестируем файл: {image_path}")
    print(f"Размер: {len(image_bytes)} байт")
    print(f"{'='*60}\n")
    
    result = analyze_image(image_bytes, filename=Path(image_path).name)
    
    print(f"\n{'='*60}")
    print("РЕЗУЛЬТАТ:")
    print(f"  is_clean: {result.is_clean}")
    print(f"  label: {result.label}")
    print(f"  confidence: {result.confidence:.3f}")
    print(f"  reason: {result.reason}")
    print(f"  raw_scores: {result.raw_scores}")
    print(f"{'='*60}\n")
    
    if result.is_clean:
        print("❌ ПРОБЛЕМА: Фото ПРОПУЩЕНО (должно быть заблокировано)")
        return False
    else:
        print("✅ ОК: Фото ЗАБЛОКИРОВАНО")
        return True


if __name__ == "__main__":
    # Для теста нужно передать путь к изображению
    if len(sys.argv) < 2:
        print("Использование: python test_moderation_underwear.py <путь_к_изображению>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    if not Path(image_path).exists():
        print(f"Ошибка: файл не найден: {image_path}")
        sys.exit(1)
    
    success = test_image(image_path)
    sys.exit(0 if success else 1)
