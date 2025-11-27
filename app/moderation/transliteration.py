"""Utility helpers for detecting and converting transliterated obscene words."""
from __future__ import annotations

from functools import lru_cache
from typing import Dict, List

LEET_MAP = str.maketrans({
    "4": "a",
    "@": "a",
    "0": "o",
    "3": "e",
    "1": "l",
    "!": "l",
    "$": "s",
    "5": "s",
    "7": "t",
    "6": "b",
    "8": "v",
})

LATIN_CLUSTERS: List[tuple[str, str]] = [
    ("shch", "щ"),
    ("sch", "щ"),
    ("zh", "ж"),
    ("kh", "х"),
    ("ts", "ц"),
    ("ch", "ч"),
    ("sh", "ш"),
    ("yu", "ю"),
    ("ya", "я"),
    ("ya", "я"),
    ("yo", "ё"),
    ("ye", "е"),
    # common obscene translit to improve filtering
    ("hui", "хуи"),
    ("huy", "хуй"),
    ("hyi", "хуи"),
    ("hy", "ху"),
    ("hu", "ху"),
]

LATIN_SINGLE: Dict[str, str] = {
    "a": "а",
    "b": "б",
    "v": "в",
    "g": "г",
    "d": "д",
    "e": "е",
    "ё": "е",
    "yo": "ё",
    "ž": "ж",
    "z": "з",
    "i": "и",
    "j": "й",
    "y": "ы",
    "k": "к",
    "l": "л",
    "m": "м",
    "n": "н",
    "o": "о",
    "p": "п",
    "r": "р",
    "s": "с",
    "t": "т",
    "u": "у",
    "f": "ф",
    "h": "х",
    "c": "к",
    "q": "к",
    "w": "в",
    "x": "кс",
}

CYRILLIC_CLUSTERS: List[tuple[str, str]] = [
    ("щ", "shch"),
    ("ш", "sh"),
    ("ж", "zh"),
    ("ч", "ch"),
    ("ю", "yu"),
    ("я", "ya"),
    ("ё", "yo"),
    ("х", "kh"),
    ("ц", "ts"),
]

CYRILLIC_SINGLE: Dict[str, str] = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "kh",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ы": "y",
    "э": "e",
    "ю": "yu",
    "я": "ya",
}


def contains_latin_letters(text: str) -> bool:
    return any("a" <= ch.lower() <= "z" for ch in text if ch.isascii())


def latin_to_cyrillic(text: str) -> str:
    normalized = text.translate(LEET_MAP)
    output: List[str] = []
    i = 0
    lower = normalized.lower()
    while i < len(normalized):
        chunk = lower[i:]
        matched = False
        for latin, cyr in LATIN_CLUSTERS:
            if chunk.startswith(latin):
                output.append(_apply_case(normalized[i : i + len(latin)], cyr))
                i += len(latin)
                matched = True
                break
        if matched:
            continue
        char = normalized[i]
        mapped = LATIN_SINGLE.get(char.lower())
        if mapped:
            output.append(_apply_case(char, mapped))
        else:
            output.append(char)
        i += 1
    return "".join(output)


def cyrillic_to_latin(text: str) -> str:
    output: List[str] = []
    i = 0
    lower = text.lower()
    while i < len(text):
        chunk = lower[i:]
        matched = False
        for cyr, latin in CYRILLIC_CLUSTERS:
            if chunk.startswith(cyr):
                segment = text[i : i + len(cyr)]
                output.append(_apply_case(segment, latin))
                i += len(cyr)
                matched = True
                break
        if matched:
            continue
        char = text[i]
        mapped = CYRILLIC_SINGLE.get(char.lower())
        if mapped:
            output.append(_apply_case(char, mapped))
        else:
            output.append(char)
        i += 1
    return "".join(output)


def _apply_case(source: str, target: str) -> str:
    if not source:
        return target
    if source.isupper():
        return target.upper()
    if source[0].isupper():
        return target.capitalize()
    return target

@lru_cache
def transliteration_lookup(words: tuple[str, ...]) -> Dict[str, List[str]]:
    table: Dict[str, List[str]] = {}
    for word in words:
        latin = cyrillic_to_latin(word)
        if not latin or latin == word:
            continue
        table.setdefault(latin, []).append(word)
    return table
