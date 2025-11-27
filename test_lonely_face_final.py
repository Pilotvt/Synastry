"""
ТЕСТ: Проверка lonely_face после доработки

ЦЕЛЬ: Убедиться что:
1. Underwear фото (маленькое, только лицо) → БЛОКИРУЕТСЯ
2. Нормальные портреты (большие, >600px, только лицо) → ПРОПУСКАЮТСЯ
3. Нормальные фото с одеждой (NudeNet видит TORSO/CLOTHING) → ПРОПУСКАЮТСЯ

НОВАЯ ЛОГИКА lonely_face:
- Срабатывает если найдено ТОЛЬКО ЛИЦО (len(detections)==1)
- И выполняется ОДНО из условий:
  A) Изображение маленькое (<600px по любой стороне) — блокируем всегда
  B) Изображение большое (≥600px) И skin_ratio ≥ 0.25 — блокируем

ЗАЧЕМ ЭТО НУЖНО:
- Маленькие фото с одним лицом = типично для underwear/beach (обрезанные кадры)
- Большие фото с одним лицом + низкий skin_ratio = нормальный портрет в одежде (ПРОПУСТИТЬ)
- Большие фото с одним лицом + высокий skin_ratio = пляж/белье (БЛОКИРОВАТЬ)

ИНСТРУКЦИЯ ПО ТЕСТИРОВАНИЮ:

1. Сохраните три типа изображений в test_images/:
   
   a) male_underwear.jpg (уже есть)
      - Маленькое фото в белье
      - Ожидание: БЛОКИРОВАТЬ (маленькое + только лицо)
   
   b) normal_portrait_large.jpg
      - Большое фото (>600px), портрет человека в одежде
      - NudeNet должен найти только FACE_*
      - Ожидание: ПРОПУСТИТЬ (большое + низкий skin_ratio)
   
   c) normal_with_clothing.jpg
      - Любое фото где NudeNet находит FACE + TORSO/CLOTHING/ARMPITS
      - Ожидание: ПРОПУСТИТЬ (не lonely face, есть другие детекции)

2. Запустите тесты:

   ```powershell
   # Тест 1: underwear (должно блокироваться)
   & "C:\\Users\\user\\Git\\Synastry\\python-env\\Scripts\\python.exe" test_moderation_quick.py test_images/male_underwear.jpg
   
   # Тест 2: нормальный портрет (должно пропускаться)
   & "C:\\Users\\user\\Git\\Synastry\\python-env\\Scripts\\python.exe" test_moderation_quick.py test_images/normal_portrait_large.jpg
   
   # Тест 3: фото с одеждой (должно пропускаться)
   & "C:\\Users\\user\\Git\\Synastry\\python-env\\Scripts\\python.exe" test_moderation_quick.py test_images/normal_with_clothing.jpg
   ```

3. Проверьте логи:

   ✅ Underwear:
   ```
   [NUDENET] Detections: [{'class': 'FACE_MALE', ...}]
   [NUDENET] LONELY FACE triggered: only face (conf=0.XX) + small image (284x177)
   is_clean=False ✓ БЛОКИРОВАНО
   ```
   
   ✅ Нормальный портрет (большой):
   ```
   [NUDENET] Detections: [{'class': 'FACE_MALE', ...}]
   [NUDENET] Skin ratio = 0.10-0.20 (низкий, одежда закрывает тело)
   (LONELY FACE НЕ срабатывает: большое изображение + низкий skin_ratio)
   is_clean=True ✓ ПРОПУЩЕНО
   ```
   
   ✅ С одеждой:
   ```
   [NUDENET] Detections: [{'class': 'FACE_MALE', ...}, {'class': 'TORSO', ...}]
   (LONELY FACE НЕ срабатывает: len(detections) > 1)
   is_clean=True ✓ ПРОПУЩЕНО
   ```

НАСТРОЙКА ПОРОГА (если нужно):

Если большие портреты блокируются:
```python
# app/moderation/image.py
LONELY_FACE_SMALL_IMAGE_EDGE = 700  # было 600, сделать порог выше
```

Если большие портреты с высоким skin_ratio пропускаются:
```python
LONELY_FACE_MIN_SKIN_RATIO = 0.20  # было 0.25, сделать строже
```

СТАТУС:
- male_underwear.jpg (284x177): ✅ блокируется (small image)
- Нормальные фото из attachments: нужно проверить размеры и skin_ratio
"""
print(__doc__)
