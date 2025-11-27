"""Быстрый тест модерации изображений - использует attachment image."""
import base64
import sys
from pathlib import Path

# Настройка путей
root = Path(__file__).parent
sys.path.insert(0, str(root))

from app.moderation.image import analyze_image

# Путь к тестовому изображению (пользователь должен скопировать attachment сюда)
TEST_IMAGE_PATH = root / "test_images" / "male_underwear.jpg"

def main():
    if not TEST_IMAGE_PATH.exists():
        print(f"❌ Ошибка: Сохраните приложенное изображение как {TEST_IMAGE_PATH}")
        print("   Или передайте путь как аргумент: python test_moderation_quick.py <путь>")
        if len(sys.argv) > 1:
            image_path = Path(sys.argv[1])
            if not image_path.exists():
                print(f"   Файл не найден: {image_path}")
                return 1
        else:
            return 1
    else:
        image_path = TEST_IMAGE_PATH
    
    print(f"\n{'='*70}")
    print(f"ТЕСТ МОДЕРАЦИИ: {image_path.name}")
    print(f"{'='*70}\n")
    
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    
    print(f"Размер файла: {len(image_bytes):,} байт\n")
    
    result = analyze_image(image_bytes, filename=image_path.name)
    
    print(f"\n{'='*70}")
    print("📊 РЕЗУЛЬТАТ МОДЕРАЦИИ:")
    print(f"{'='*70}")
    print(f"  ✓ Чисто (разрешено):  {result.is_clean}")
    print(f"  ✓ Метка:              {result.label}")
    print(f"  ✓ Уверенность:        {result.confidence:.3f}")
    print(f"  ✓ Причина:            {result.reason}")
    if result.raw_scores:
        print(f"  ✓ NudeNet детекции:   {', '.join(f'{k}={v:.2f}' for k, v in list(result.raw_scores.items())[:5])}")
    print(f"{'='*70}\n")
    
    if result.is_clean:
        print("❌ ПРОВАЛ: Изображение ПРОПУЩЕНО (должно быть ЗАБЛОКИРОВАНО)")
        print("   → Нужно ужесточить пороги или добавить правила\n")
        return 1
    else:
        print("✅ УСПЕХ: Изображение ЗАБЛОКИРОВАНО корректно")
        print("   → Модерация работает как задумано\n")
        return 0

if __name__ == "__main__":
    sys.exit(main())
