"""Image moderation helpers backed by NudeNet v3 detector."""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Dict, Optional

from nudenet import NudeDetector

# Детектор фильтрует боксы по score >= 0.2. Берём максимально «эксплицитный» score.
DEFAULT_UNSAFE_THRESHOLD = 0.6
# Метки, которые считаем эксплицитными
UNSAFE_KEYWORDS = ("EXPOSED", "GENITALIA", "ANUS")


@dataclass
class ImageModerationResult:
    label: str
    confidence: float
    is_explicit: bool
    raw_scores: Dict[str, float]
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def _resolve_model_path() -> Optional[str]:
    env_override = os.environ.get("NUDENET_MODEL_PATH")
    if env_override:
        return env_override
    resource_root = os.environ.get("SYN_RESOURCE_ROOT")
    if resource_root:
        bundled = Path(resource_root) / "nudenet" / "320n.onnx"
        if bundled.exists():
            return str(bundled)
    project_root = Path(__file__).resolve().parents[1]
    dev_model = project_root / "nudenet" / "320n.onnx"
    if dev_model.exists():
        return str(dev_model)
    return None


@lru_cache
def _detector() -> NudeDetector:
    model_path = _resolve_model_path()
    return NudeDetector(model_path=model_path) if model_path else NudeDetector()


def _suffix_from_filename(filename: Optional[str]) -> str:
    if not filename:
        return ".jpg"
    suffix = Path(filename).suffix
    return suffix if suffix else ".jpg"


def analyze_image(image_bytes: bytes, filename: Optional[str] = None) -> ImageModerationResult:
    """Run NudeNet detector on raw bytes and return structured verdict."""
    if not image_bytes:
        raise ValueError("Пустое изображение")

    suffix = _suffix_from_filename(filename)
    tmp_path: Optional[str] = None
    try:
        with NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(image_bytes)
            tmp.flush()
            tmp_path = tmp.name

        detections = _detector().detect(tmp_path) or []
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)

    # max score по «опасным» меткам
    unsafe_score = 0.0
    scores: Dict[str, float] = {}
    for det in detections:
        label = det.get("label", "")
        score = float(det.get("score", 0.0))
        scores[label] = max(scores.get(label, 0.0), score)
        if any(key in label for key in UNSAFE_KEYWORDS):
            unsafe_score = max(unsafe_score, score)

    unsafe_score = min(max(unsafe_score, 0.0), 1.0)
    safe_score = max(0.0, 1.0 - unsafe_score)
    label = "unsafe" if unsafe_score >= safe_score else "safe"
    confidence = unsafe_score if label == "unsafe" else safe_score
    is_explicit = unsafe_score >= DEFAULT_UNSAFE_THRESHOLD
    reason = f"NudeNet unsafe={unsafe_score:.2f}" if is_explicit else f"NudeNet safe={safe_score:.2f}"

    return ImageModerationResult(
        label=label,
        confidence=confidence,
        is_explicit=is_explicit,
        raw_scores=scores,
        reason=reason,
    )
