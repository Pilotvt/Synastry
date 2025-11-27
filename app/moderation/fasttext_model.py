"""fastText-based profanity detection for transliterated content."""
from __future__ import annotations

import argparse
import random
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple

import fasttext

from .transliteration import cyrillic_to_latin
from ..resource_paths import resource_path

DATA_DIR = resource_path("data")
DICTIONARY_FILE = DATA_DIR / "profanity_ru_ua.txt"
TRAINING_FILE = DATA_DIR / "profanity_fasttext.train"
MODEL_FILE = DATA_DIR / "profanity_fasttext.bin"
LABEL_DIRTY = "__label__dirty"
LABEL_CLEAN = "__label__clean"
DIRTY_THRESHOLD = 0.55

BASE_CLEAN_PHRASES: Sequence[str] = (
    "добрый вечер",
    "хочу найти любовь",
    "привет, как дела",
    "ищу серьёзные отношения",
    "расскажи о своём дне",
    "мне нравится йога",
    "пойдём в музей",
    "читаю классику",
    "люблю котов",
    "путешествую по миру",
    "занимаюсь музыкой",
    "работаю дизайнером",
    "ищу собеседника",
)


def _load_dictionary() -> List[str]:
    if not DICTIONARY_FILE.exists():
        raise FileNotFoundError(f"Не найден словарь: {DICTIONARY_FILE}")
    words: List[str] = []
    for line in DICTIONARY_FILE.read_text(encoding="utf-8").splitlines():
        token = line.strip()
        if not token or token.startswith("#"):
            continue
        words.append(token)
    if not words:
        raise RuntimeError("Словарь ненормативной лексики пуст")
    return words


def _generate_dirty_samples(words: Sequence[str]) -> Iterable[str]:
    for word in words:
        translit = cyrillic_to_latin(word)
        variants = {
            word,
            word.upper(),
            f"ты {word}",
            f"какая {word}",
            f"{word}!!!",
        }
        if translit and translit != word:
            variants.update(
                {
                    translit,
                    translit.upper(),
                    f"ti {translit}",
                    f"kakaya {translit}",
                    f"{translit}!!!",
                }
            )
        for variant in variants:
            yield variant


def _generate_clean_samples() -> Iterable[str]:
    for phrase in BASE_CLEAN_PHRASES:
        yield phrase
        yield phrase.capitalize()
        yield f"{phrase} сегодня"
    neutral_additions = (
        "доброе утро",
        "прекрасный день",
        "интересный фильм",
        "новый проект",
        "семейный ужин",
    )
    for phrase in neutral_additions:
        yield phrase


def _ensure_training_corpus() -> Path:
    if TRAINING_FILE.exists():
        return TRAINING_FILE

    words = _load_dictionary()
    lines: List[str] = []
    for dirty in _generate_dirty_samples(words):
        lines.append(f"{LABEL_DIRTY} {dirty}")
    for clean in _generate_clean_samples():
        lines.append(f"{LABEL_CLEAN} {clean}")

    random.Random(42).shuffle(lines)
    TRAINING_FILE.write_text("\n".join(lines), encoding="utf-8")
    return TRAINING_FILE


def train_model(force: bool = False) -> Path:
    if MODEL_FILE.exists() and not force:
        return MODEL_FILE

    training_file = _ensure_training_corpus()
    model = fasttext.train_supervised(
        input=str(training_file),
        lr=0.3,
        wordNgrams=2,
        epoch=35,
        dim=50,
        minn=2,
        maxn=4,
        loss="ova",
    )
    model.save_model(str(MODEL_FILE))
    return MODEL_FILE


def ensure_model() -> Path:
    if not MODEL_FILE.exists():
        return train_model()
    return MODEL_FILE


@lru_cache
def _model():
    ensure_model()
    return fasttext.load_model(str(MODEL_FILE))


def predict_profanity(text: str) -> Tuple[str, float]:
    payload = (text or "").replace("\n", " ").strip()
    if not payload:
        return "clean", 0.0

    model = _model()
    labels, probs = model.predict(payload, k=2)
    scores = dict(zip(labels, probs))
    dirty_score = float(scores.get(LABEL_DIRTY, 0.0))
    clean_score = float(scores.get(LABEL_CLEAN, 0.0))
    label = "dirty" if dirty_score >= clean_score else "clean"
    return label, dirty_score


def main() -> None:
    parser = argparse.ArgumentParser(description="fastText profanity model helper")
    parser.add_argument("--train", action="store_true", help="force retrain the model")
    args = parser.parse_args()

    if args.train:
        path = train_model(force=True)
        print(f"[fasttext_model] trained model saved to {path}")
    else:
        path = ensure_model()
        print(f"[fasttext_model] model ready at {path}")


if __name__ == "__main__":
    main()
