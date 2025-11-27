"""Profanity detection utilities for Russian and Ukrainian content."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import List, Sequence

from better_profanity import Profanity

# ALLOWED_CHARACTERS переехал в better_profanity.constants начиная с 0.7.0.
# Сохраняем совместимость со старыми версиями и не падаем, если utils больше не экспортирует константу.
try:  # pragma: no cover - импорт в рантайме зависит от версии пакета
    from better_profanity.constants import ALLOWED_CHARACTERS
except ImportError:  # pragma: no cover
    from better_profanity.utils import ALLOWED_CHARACTERS

from better_profanity.utils import any_next_words_form_swear_word, get_replacement_for_swear_word

from .fasttext_model import DIRTY_THRESHOLD, predict_profanity
from .transliteration import contains_latin_letters, latin_to_cyrillic
from ..resource_paths import resource_path

DATA_DIR = resource_path("data")
WORDLIST_FILENAME = "profanity_ru_ua.txt"
SUPPORTED_LANG_HINTS = {
    "auto",
    "ru",
    "ru-ru",
    "uk",
    "uk-ua",
}


@dataclass
class TextModerationResult:
    """Structured result container returned by ``analyze_text``."""

    is_clean: bool
    matches: List[str]
    censored_text: str
    model_label: str | None = None
    model_confidence: float | None = None
    reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@lru_cache
def _dictionary_path() -> Path:
    path = DATA_DIR / WORDLIST_FILENAME
    if not path.exists():
        raise FileNotFoundError(
            f"Не найден словарь ненормативной лексики: {path.as_posix()}"
        )
    return path


@lru_cache
def _profanity_engine() -> Profanity:
    detector = Profanity()
    detector.load_censor_words_from_file(str(_dictionary_path()))
    return detector


def analyze_text(text: str, language_hint: str | None = None) -> TextModerationResult:
    """Check text for obscene lexicon and return structured verdict."""

    payload = text or ""
    language = _normalize_language_hint(language_hint)
    if language not in SUPPORTED_LANG_HINTS:
        return TextModerationResult(is_clean=True, matches=[], censored_text=payload)

    detector = _profanity_engine()
    reasons: List[str] = []

    censored_text, base_matches = _censor_with_matches(detector, payload)

    translit_matches: List[str] = []
    if contains_latin_letters(payload):
        transliterated = latin_to_cyrillic(payload)
        _, translit_matches = _censor_with_matches(detector, transliterated)

    combined_matches = base_matches + translit_matches
    unique_matches = _deduplicate_preserving_order(combined_matches)

    if base_matches:
        preview = ", ".join(_shorten_matches(base_matches))
        reasons.append(f"лексика: {preview}")
    if translit_matches:
        preview = ", ".join(_shorten_matches(translit_matches))
        reasons.append(f"транслит: {preview}")

    flagged = bool(unique_matches)

    model_label: str | None = None
    model_confidence: float | None = None
    if not flagged:
        model_label, model_confidence = predict_profanity(payload)
        if model_label == "dirty" and (model_confidence or 0.0) >= DIRTY_THRESHOLD:
            flagged = True
            reasons.append(
                "fastText: вероятность {0:.2f}".format(model_confidence or 0.0)
            )

    return TextModerationResult(
        is_clean=not flagged,
        matches=unique_matches,
        censored_text=censored_text,
        model_label=model_label,
        model_confidence=model_confidence,
        reasons=reasons,
    )


def _deduplicate_preserving_order(matches: Sequence[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for match in matches:
        key = match.lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(match)
    return ordered


def _shorten_matches(matches: Sequence[str], limit: int = 3) -> List[str]:
    preview = list(dict.fromkeys(match.strip() for match in matches if match.strip()))
    if len(preview) > limit:
        preview = preview[:limit] + ["…"]
    return preview


def _normalize_language_hint(language_hint: str | None) -> str:
    if not language_hint:
        return "auto"
    return language_hint.replace("_", "-").lower()


def _censor_with_matches(
    detector: Profanity, text: str, censor_char: str = "*"
) -> tuple[str, List[str]]:
    """Replicates ``better_profanity`` censor logic while tracking matches."""

    if not text:
        return text, []

    start_idx = detector._get_start_index_of_next_word(text, 0)
    if start_idx >= len(text) - 1:
        return text, []

    prefix = text[:start_idx]
    working_text = text[start_idx:]
    if not working_text:
        return text, []

    censored_text = prefix
    matches: List[str] = []
    cur_word = ""
    cur_word_start: int | None = None
    skip_index = -1
    next_words_indices: list = []
    censor_wordset = set(str(word).lower() for word in detector.CENSOR_WORDSET)

    for index, char in enumerate(working_text):
        if index < skip_index:
            continue

        if char in ALLOWED_CHARACTERS:
            if not cur_word:
                cur_word_start = index
            cur_word += char
            continue

        if not cur_word.strip():
            censored_text += char
            cur_word = ""
            cur_word_start = None
            continue

        next_words_indices = detector._update_next_words_indices(
            working_text, next_words_indices, index
        )
        contains, end_index = any_next_words_form_swear_word(
            cur_word, next_words_indices, censor_wordset
        )
        if contains and cur_word_start is not None:
            matches.append(working_text[cur_word_start:end_index])
            cur_word = get_replacement_for_swear_word(censor_char)
            skip_index = end_index
            char = ""
            next_words_indices = []
            cur_word_start = None
        elif cur_word.lower() in censor_wordset:
            if cur_word_start is not None:
                matches.append(working_text[cur_word_start:index])
            cur_word = get_replacement_for_swear_word(censor_char)
            cur_word_start = None

        censored_text += cur_word + char
        cur_word = ""

    if cur_word:
        if cur_word_start is not None and cur_word.lower() in censor_wordset:
            matches.append(working_text[cur_word_start:])
            cur_word = get_replacement_for_swear_word(censor_char)
        censored_text += cur_word

    return censored_text, matches
