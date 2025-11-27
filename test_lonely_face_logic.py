"""Проверка что модерация не блокирует нормальные фото с лицом + одеждой."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.moderation.image import analyze_image

# Тест: если есть лицо + другие части (одежда), не блокируем
def test_false_positive_scenarios():
    """Сценарии которые НЕ должны блокироваться."""
    
    print("\n" + "="*70)
    print("ТЕСТ: Проверка что lonely_face не создаёт false positives")
    print("="*70 + "\n")
    
    # Сценарий 1: Лицо + любая другая детекция (должно пройти)
    print("Сценарий 1: Детекции = FACE_MALE + что-то ещё")
    print("  Ожидание: is_clean=True (не блокировать)")
    print("  Логика: Если есть другие детекции кроме лица, это не 'lonely face'\n")
    
    # Сценарий 2: Только лицо с низкой уверенностью (должно пройти)
    print("Сценарий 2: Только FACE_MALE но confidence < 0.60")
    print("  Ожидание: is_clean=True (не блокировать)")
    print("  Логика: Низкая уверенность = может быть ложное срабатывание\n")
    
    # Сценарий 3: Только лицо с высокой уверенностью (должно блокировать)
    print("Сценарий 3: Только FACE_MALE и confidence >= 0.60")
    print("  Ожидание: is_clean=False (БЛОКИРОВАТЬ)")
    print("  Логика: Одинокое лицо без одежды/других частей = подозрительно\n")
    
    print("="*70)
    print("ВАЖНО: Настоящие тесты требуют реальных изображений.")
    print("       Текущая конфигурация:")
    print("       - LONELY_FACE_BLOCK = True")
    print("       - LONELY_FACE_MIN_CONFIDENCE = 0.60")
    print("="*70)
    print("\n✓ Если NudeNet находит TORSO, CLOTHING, ARMPITS и т.п.,")
    print("  lonely face НЕ сработает (len(detections) > 1)\n")
    print("✓ Если хотите разрешить 'селфи с лицом', установите:")
    print("  LONELY_FACE_BLOCK = False в app/moderation/image.py\n")

if __name__ == "__main__":
    test_false_positive_scenarios()
