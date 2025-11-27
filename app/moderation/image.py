"""Image moderation helpers backed by NudeNet v3 detector (stricter rules).

Adds conservative heuristics to catch missed cases (e.g., male underwear) by
estimating non-face skin coverage using YCbCr thresholding. This blocks
"beach/underwear" photos even when NudeNet detects only a face.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from io import BytesIO
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Dict, Optional

from nudenet import NudeDetector
import numpy as np
from PIL import Image

# Flag explicit if unsafe score crosses this threshold (stricter than default).
DEFAULT_UNSAFE_THRESHOLD = 0.45
# Threshold for exposed breast detection - block all nudity
BREAST_EXPOSED_THRESHOLD = 0.40
# Male breast threshold - also strict, no beach photos allowed
MALE_BREAST_EXPOSED_THRESHOLD = 0.40
# Threshold for covered breast - more lenient to allow normal clothing
BREAST_COVERED_THRESHOLD = 0.75
# Threshold for exposed buttocks
BUTTOCK_EXPOSED_THRESHOLD = 0.45
# Genitalia thresholds: exposed is strict, covered is more lenient but still blocked at higher confidence
GENITALIA_EXPOSED_THRESHOLD = 0.35
GENITALIA_COVERED_THRESHOLD = 0.40
# Keywords that mark unsafe detections. NudeNet v3 labels contain these substrings.
UNSAFE_KEYWORDS = ("ANUS",)  # keep only the most explicit generic keyword; others handled explicitly below
# Strict keywords for exposed breast
BREAST_EXPOSED_KEYWORDS = ("FEMALE_BREAST_EXPOSED",)
MALE_BREAST_EXPOSED_KEYWORDS = ("MALE_BREAST_EXPOSED",)
# Lenient keywords for covered breast (higher threshold needed)
BREAST_COVERED_KEYWORDS = ("BREAST_COVERED", "FEMALE_BREAST_COVERED")
# Keywords for buttocks detection
BUTTOCK_KEYWORDS = ("BUTTOCKS_EXPOSED", "BUTTOCK_EXPOSED")
# Genitalia keywords
GENITALIA_EXPOSED_KEYWORDS = ("FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED", "GENITALIA_EXPOSED")
GENITALIA_COVERED_KEYWORDS = ("FEMALE_GENITALIA_COVERED", "MALE_GENITALIA_COVERED", "GENITALIA_COVERED")
GROIN_EXPOSED_KEYWORDS = ("GROIN_EXPOSED",)
GROIN_COVERED_KEYWORDS = ("GROIN_COVERED",)
GROIN_EXPOSED_THRESHOLD = 0.40
GROIN_COVERED_THRESHOLD = 0.55
# Exposed belly threshold - block high-confidence belly exposure (often porn/nudity)
BELLY_EXPOSED_THRESHOLD = 0.60
# Heuristic: exposed belly + legs/feet without upper clothing suggests underwear
BELLY_EXPOSED_KEYWORDS = ("BELLY_EXPOSED", "BELLY")
FEET_LEGS_KEYWORDS = ("FEET_EXPOSED", "LEGS_EXPOSED", "FEET", "LEGS")
BELLY_THRESHOLD = 0.45
# If belly+legs detected together without torso clothing, likely underwear photo
UNDERWEAR_HEURISTIC_THRESHOLD = 0.35

# Skin coverage fallback: if a face is detected but non-face skin coverage is
# high, consider it unsafe (blocks beach/underwear style images).
# Raised to 0.50 to avoid blocking photos with visible hands/arms (e.g., working at desk)
SKIN_RATIO_NONFACE_THRESHOLD = 0.50
SKIN_MIN_IMAGE_EDGE = 128  # skip heuristic on tiny images

# Lonely face heuristic: DISABLED - even 640m model doesn't detect clothing/covered body parts
# NudeNet only detects exposed/covered intimate areas, not normal clothing
# This heuristic was blocking normal portrait photos (e.g., professional headshots)
LONELY_FACE_BLOCK = False  # disabled - causes false positives on normal portraits
LONELY_FACE_MIN_CONFIDENCE = 0.60  # minimum face confidence to trigger
LONELY_FACE_MIN_SKIN_RATIO = 0.25  # for large images, require high skin ratio
LONELY_FACE_SMALL_IMAGE_EDGE = 600  # images smaller than this are always suspicious if lonely face

# Minimum image quality threshold: block very small images as low-quality/suspicious
# NudeNet 640m model: trained on 640x640, requires good resolution for accurate detection
# Small images lack detail → detector misses exposed body parts → block proactively
MIN_IMAGE_EDGE_FOR_DATING = 640  # block if either dimension < this (too low quality)


@dataclass
class ImageModerationResult:
    label: str
    confidence: float
    is_clean: bool  # Renamed from is_explicit - True means safe, False means blocked
    raw_scores: Dict[str, float]
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def _resolve_model_path() -> Optional[str]:
    env_override = os.environ.get("NUDENET_MODEL_PATH")
    if env_override:
        print(f"[NUDENET] Using model from env: {env_override}")
        return env_override
    resource_root = os.environ.get("SYN_RESOURCE_ROOT")
    if resource_root:
        bundled = Path(resource_root) / "nudenet" / "640m.onnx"
        if bundled.exists():
            print(f"[NUDENET] Using bundled model: {bundled}")
            return str(bundled)
    project_root = Path(__file__).resolve().parents[1]
    dev_model = project_root / "nudenet" / "640m.onnx"
    if dev_model.exists():
        print(f"[NUDENET] Using dev model: {dev_model}")
        return str(dev_model)
    print("[NUDENET] WARNING: No model found, using default NudeNet download")
    return None


@lru_cache
def _detector() -> NudeDetector:
    model_path = _resolve_model_path()
    detector = NudeDetector(model_path=model_path, inference_resolution=640) if model_path else NudeDetector(inference_resolution=640)
    print(f"[NUDENET] Detector initialized with 640m model: {model_path}")
    return detector


def _suffix_from_filename(filename: Optional[str]) -> str:
    if not filename:
        return ".jpg"
    suffix = Path(filename).suffix
    return suffix if suffix else ".jpg"


def analyze_image(image_bytes: bytes, filename: Optional[str] = None) -> ImageModerationResult:
    """Run NudeNet detector on raw bytes and return structured verdict."""
    if not image_bytes:
        raise ValueError("Пустое изображение")

    # Prepare image for potential skin coverage heuristic
    try:
        pil_img = Image.open(BytesIO(image_bytes)).convert("RGB")
        img_w, img_h = pil_img.size
        
        # Block very small images proactively (low quality, NudeNet misses details)
        if img_w < MIN_IMAGE_EDGE_FOR_DATING or img_h < MIN_IMAGE_EDGE_FOR_DATING:
            print(f"[NUDENET] Image too small ({img_w}x{img_h}), minimum {MIN_IMAGE_EDGE_FOR_DATING}px required for dating profiles")
            return ImageModerationResult(
                label="unsafe",
                confidence=1.0,
                is_clean=False,
                raw_scores={"LOW_RESOLUTION": 1.0},
                reason=f"Image resolution too low ({img_w}x{img_h}px), minimum {MIN_IMAGE_EDGE_FOR_DATING}px required"
            )
    except Exception as e:
        print(f"[NUDENET] WARNING: Failed to open image for heuristics: {e}")
        pil_img = None
        img_w = img_h = 0

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

    # Log all detections for debugging
    print(f"[NUDENET] Detections for {filename}: {detections}")

    # Max unsafe score per dangerous label
    unsafe_score = 0.0
    breast_exposed_score = 0.0
    male_breast_exposed_score = 0.0
    breast_covered_score = 0.0
    buttock_score = 0.0
    genitalia_exposed_score = 0.0
    genitalia_covered_score = 0.0
    belly_score = 0.0
    groin_exposed_score = 0.0
    groin_covered_score = 0.0
    belly_score = 0.0
    feet_legs_score = 0.0
    scores: Dict[str, float] = {}
    face_boxes = []  # collect face boxes to exclude from skin computation
    face_present = False
    male_face_present = False
    female_face_present = False
    for det in detections:
        # NudeNet uses 'class' key, not 'label'
        label = det.get("class", det.get("label", ""))
        score = float(det.get("score", 0.0))
        scores[label] = max(scores.get(label, 0.0), score)
        
        label_upper = label.upper()
        
        # Face collection for skin heuristic
        label_upper = label.upper()
        if "FACE" in label_upper:
            face_present = True
            male_face_present = male_face_present or ("MALE" in label_upper)
            female_face_present = female_face_present or ("FEMALE" in label_upper)
            # try to read box in either dict or list form
            box = det.get("box")
            if not box:
                # support alt format {x1,y1,x2,y2}
                x1 = det.get("x1"); y1 = det.get("y1"); x2 = det.get("x2"); y2 = det.get("y2")
                if None not in (x1, y1, x2, y2):
                    box = [x1, y1, x2, y2]
            if box and pil_img is not None and img_w and img_h:
                try:
                    xb = list(box)
                    # normalize if coordinates in [0,1]
                    if max(xb) <= 1.0:
                        x1, y1, x2, y2 = int(xb[0] * img_w), int(xb[1] * img_h), int(xb[2] * img_w), int(xb[3] * img_h)
                    else:
                        x1, y1, x2, y2 = int(xb[0]), int(xb[1]), int(xb[2]), int(xb[3])
                    # clamp
                    x1 = max(0, min(img_w - 1, x1)); x2 = max(0, min(img_w, x2))
                    y1 = max(0, min(img_h - 1, y1)); y2 = max(0, min(img_h, y2))
                    if x2 > x1 and y2 > y1:
                        face_boxes.append((x1, y1, x2, y2))
                except Exception as e:
                    print(f"[NUDENET] WARNING: failed to parse face box: {e}")

        # Check for EXPOSED female breast with strict threshold
        if any(key in label_upper for key in BREAST_EXPOSED_KEYWORDS):
            breast_exposed_score = max(breast_exposed_score, score)
            print(f"[NUDENET] BREAST_EXPOSED detected: {label} = {score:.3f}")
        
        # Check for MALE breast separately with lenient threshold
        elif any(key in label_upper for key in MALE_BREAST_EXPOSED_KEYWORDS):
            male_breast_exposed_score = max(male_breast_exposed_score, score)
            print(f"[NUDENET] MALE_BREAST_EXPOSED detected: {label} = {score:.3f}")
        
        # Check for COVERED breast with more lenient threshold
        elif any(key in label_upper for key in BREAST_COVERED_KEYWORDS):
            breast_covered_score = max(breast_covered_score, score)
            print(f"[NUDENET] BREAST_COVERED detected: {label} = {score:.3f}")
        
        # Check for buttock-related labels
        if any(key in label_upper for key in BUTTOCK_KEYWORDS):
            buttock_score = max(buttock_score, score)
            print(f"[NUDENET] BUTTOCK detected: {label} = {score:.3f}")
        
        # Genitalia (explicit and covered)
        if any(key in label_upper for key in GENITALIA_EXPOSED_KEYWORDS):
            genitalia_exposed_score = max(genitalia_exposed_score, score)
            print(f"[NUDENET] GENITALIA_EXPOSED detected: {label} = {score:.3f}")
        elif any(key in label_upper for key in GENITALIA_COVERED_KEYWORDS):
            genitalia_covered_score = max(genitalia_covered_score, score)
            print(f"[NUDENET] GENITALIA_COVERED detected: {label} = {score:.3f}")

        # Groin region (some model variants use this nomenclature)
        if any(key in label_upper for key in GROIN_EXPOSED_KEYWORDS):
            groin_exposed_score = max(groin_exposed_score, score)
            print(f"[NUDENET] GROIN_EXPOSED detected: {label} = {score:.3f}")
        elif any(key in label_upper for key in GROIN_COVERED_KEYWORDS):
            groin_covered_score = max(groin_covered_score, score)
            print(f"[NUDENET] GROIN_COVERED detected: {label} = {score:.3f}")

        # Heuristic indicators: belly and feet/legs suggest underwear/swimwear
        if any(key in label_upper for key in BELLY_EXPOSED_KEYWORDS):
            belly_score = max(belly_score, score)
            print(f"[NUDENET] BELLY detected: {label} = {score:.3f}")
        
        if any(key in label_upper for key in FEET_LEGS_KEYWORDS):
            feet_legs_score = max(feet_legs_score, score)
            print(f"[NUDENET] FEET/LEGS detected: {label} = {score:.3f}")

        # Other highly explicit generic keywords (e.g., ANUS)
        if any(key in label_upper for key in UNSAFE_KEYWORDS):
            unsafe_score = max(unsafe_score, score)
            print(f"[NUDENET] UNSAFE generic detected: {label} = {score:.3f}")

    # Lonely face heuristic: computed after skin_ratio to avoid false positives
    lonely_face_triggered = False

    # Skin coverage fallback heuristic
    skin_ratio_triggered = False
    skin_ratio_value = 0.0
    def _compute_skin_ratio(img: Image.Image, face_regions: list[tuple[int,int,int,int]]) -> float:
        # YCbCr rule-of-thumb thresholds; keep conservative
        ycbcr = np.asarray(img.convert("YCbCr"))
        Y = ycbcr[:, :, 0]
        Cb = ycbcr[:, :, 1]
        Cr = ycbcr[:, :, 2]
        # Basic skin mask (broad)
        skin_mask = (Cb >= 80) & (Cb <= 135) & (Cr >= 135) & (Cr <= 180) & (Y >= 60)
        # Exclude face regions from mask and total area
        total_mask = np.ones(skin_mask.shape[:2], dtype=bool)
        h, w = skin_mask.shape[:2]
        for (x1, y1, x2, y2) in face_regions:
            x1c = max(0, min(w, x1)); x2c = max(0, min(w, x2))
            y1c = max(0, min(h, y1)); y2c = max(0, min(h, y2))
            if x2c > x1c and y2c > y1c:
                total_mask[y1c:y2c, x1c:x2c] = False
                skin_mask[y1c:y2c, x1c:x2c] = False
        valid_area = np.count_nonzero(total_mask)
        if valid_area <= 0:
            return 0.0
        skin_count = np.count_nonzero(skin_mask & total_mask)
        return skin_count / float(valid_area)

    # Run skin ratio heuristic even without face detection (catches porn without faces)
    if pil_img is not None and img_w >= SKIN_MIN_IMAGE_EDGE and img_h >= SKIN_MIN_IMAGE_EDGE:
        try:
            skin_ratio_value = _compute_skin_ratio(pil_img, face_boxes)
            print(f"[NUDENET] Skin ratio (non-face) = {skin_ratio_value:.3f} (threshold={SKIN_RATIO_NONFACE_THRESHOLD})")
            if skin_ratio_value >= SKIN_RATIO_NONFACE_THRESHOLD:
                skin_ratio_triggered = True
                unsafe_score = max(unsafe_score, float(min(skin_ratio_value + 0.05, 1.0)))
            
            # Lonely face: trigger if ONE face detected AND (small image OR high skin ratio)
            if LONELY_FACE_BLOCK and len(detections) == 1:
                face_conf = scores.get("FACE_MALE", scores.get("FACE_FEMALE", 0.0))
                is_small_image = (img_w < LONELY_FACE_SMALL_IMAGE_EDGE or img_h < LONELY_FACE_SMALL_IMAGE_EDGE)
                has_high_skin = skin_ratio_value >= LONELY_FACE_MIN_SKIN_RATIO
                
                if face_conf >= LONELY_FACE_MIN_CONFIDENCE and (is_small_image or has_high_skin):
                    lonely_face_triggered = True
                    unsafe_score = max(unsafe_score, 0.50)
                    reason = f"small image ({img_w}x{img_h})" if is_small_image else f"high skin ratio ({skin_ratio_value:.3f})"
                    print(f"[NUDENET] LONELY FACE triggered: only face (conf={face_conf:.3f}) + {reason}, likely inappropriate")
        except Exception as e:
            print(f"[NUDENET] WARNING: skin ratio heuristic failed: {e}")

    # Apply thresholds - exposed parts need lower threshold, covered parts need higher
    if breast_exposed_score >= BREAST_EXPOSED_THRESHOLD:
        unsafe_score = max(unsafe_score, breast_exposed_score)
    if male_breast_exposed_score >= MALE_BREAST_EXPOSED_THRESHOLD:
        unsafe_score = max(unsafe_score, male_breast_exposed_score)
    if breast_covered_score >= BREAST_COVERED_THRESHOLD:
        unsafe_score = max(unsafe_score, breast_covered_score)
    if buttock_score >= BUTTOCK_EXPOSED_THRESHOLD:
        unsafe_score = max(unsafe_score, buttock_score)
    if genitalia_exposed_score >= GENITALIA_EXPOSED_THRESHOLD:
        unsafe_score = max(unsafe_score, genitalia_exposed_score)
    if genitalia_covered_score >= GENITALIA_COVERED_THRESHOLD:
        unsafe_score = max(unsafe_score, genitalia_covered_score)
    if belly_score >= BELLY_EXPOSED_THRESHOLD:
        unsafe_score = max(unsafe_score, belly_score)
    if groin_exposed_score >= GROIN_EXPOSED_THRESHOLD:
        unsafe_score = max(unsafe_score, groin_exposed_score)
    if groin_covered_score >= GROIN_COVERED_THRESHOLD:
        unsafe_score = max(unsafe_score, groin_covered_score)

    # Heuristic: belly + feet/legs combo suggests underwear/minimal clothing
    underwear_heuristic = (belly_score >= BELLY_THRESHOLD and 
                          feet_legs_score >= UNDERWEAR_HEURISTIC_THRESHOLD)
    if underwear_heuristic:
        # Combine scores for underwear detection
        heuristic_score = min((belly_score + feet_legs_score) / 2.0, 1.0)
        unsafe_score = max(unsafe_score, heuristic_score)
        print(f"[NUDENET] UNDERWEAR HEURISTIC triggered: belly={belly_score:.3f} + feet/legs={feet_legs_score:.3f} = {heuristic_score:.3f}")

    unsafe_score = min(max(unsafe_score, 0.0), 1.0)
    safe_score = max(0.0, 1.0 - unsafe_score)
    label = "unsafe" if unsafe_score >= safe_score else "safe"
    confidence = unsafe_score if label == "unsafe" else safe_score
    is_explicit = (unsafe_score >= DEFAULT_UNSAFE_THRESHOLD or 
                   breast_exposed_score >= BREAST_EXPOSED_THRESHOLD or
                   male_breast_exposed_score >= MALE_BREAST_EXPOSED_THRESHOLD or
                   breast_covered_score >= BREAST_COVERED_THRESHOLD or
                   buttock_score >= BUTTOCK_EXPOSED_THRESHOLD or
                   genitalia_exposed_score >= GENITALIA_EXPOSED_THRESHOLD or
                   genitalia_covered_score >= GENITALIA_COVERED_THRESHOLD or
                   groin_exposed_score >= GROIN_EXPOSED_THRESHOLD or
                   groin_covered_score >= GROIN_COVERED_THRESHOLD or
                   underwear_heuristic or
                   skin_ratio_triggered or
                   lonely_face_triggered)
    
    print(f"[NUDENET] Final scores - unsafe={unsafe_score:.3f}, breast_exposed={breast_exposed_score:.3f}, male_breast={male_breast_exposed_score:.3f}, breast_covered={breast_covered_score:.3f}, buttock={buttock_score:.3f}, gen_exposed={genitalia_exposed_score:.3f}, gen_covered={genitalia_covered_score:.3f}, groin_exposed={groin_exposed_score:.3f}, groin_covered={groin_covered_score:.3f}")
    print(f"[NUDENET] Thresholds - unsafe>={DEFAULT_UNSAFE_THRESHOLD}, breast_exposed>={BREAST_EXPOSED_THRESHOLD}, male_breast>={MALE_BREAST_EXPOSED_THRESHOLD}, breast_covered>={BREAST_COVERED_THRESHOLD}, buttock>={BUTTOCK_EXPOSED_THRESHOLD}, gen_exposed>={GENITALIA_EXPOSED_THRESHOLD}, gen_covered>={GENITALIA_COVERED_THRESHOLD}, groin_exposed>={GROIN_EXPOSED_THRESHOLD}, groin_covered>={GROIN_COVERED_THRESHOLD}")
    print(f"[NUDENET] is_explicit={is_explicit}, is_clean={not is_explicit}")
    
    reason_parts = []
    if breast_exposed_score >= BREAST_EXPOSED_THRESHOLD:
        reason_parts.append(f"breast_exposed={breast_exposed_score:.2f}")
    if male_breast_exposed_score >= MALE_BREAST_EXPOSED_THRESHOLD:
        reason_parts.append(f"male_breast={male_breast_exposed_score:.2f}")
    if breast_covered_score >= BREAST_COVERED_THRESHOLD:
        reason_parts.append(f"breast_covered={breast_covered_score:.2f}")
    if buttock_score >= BUTTOCK_EXPOSED_THRESHOLD:
        reason_parts.append(f"buttock={buttock_score:.2f}")
    if genitalia_exposed_score >= GENITALIA_EXPOSED_THRESHOLD:
        reason_parts.append(f"genitalia_exposed={genitalia_exposed_score:.2f}")
    if genitalia_covered_score >= GENITALIA_COVERED_THRESHOLD:
        reason_parts.append(f"genitalia_covered={genitalia_covered_score:.2f}")
    if groin_exposed_score >= GROIN_EXPOSED_THRESHOLD:
        reason_parts.append(f"groin_exposed={groin_exposed_score:.2f}")
    if groin_covered_score >= GROIN_COVERED_THRESHOLD:
        reason_parts.append(f"groin_covered={groin_covered_score:.2f}")
    if underwear_heuristic:
        reason_parts.append(f"underwear_heuristic(belly={belly_score:.2f}+legs={feet_legs_score:.2f})")
    if unsafe_score >= DEFAULT_UNSAFE_THRESHOLD:
        reason_parts.append(f"unsafe={unsafe_score:.2f}")
    if skin_ratio_triggered:
        reason_parts.append(f"skin_ratio_nonface={skin_ratio_value:.2f}")
    if lonely_face_triggered:
        reason_parts.append(f"lonely_face_only")
    
    if is_explicit:
        reason = f"NudeNet blocked: {', '.join(reason_parts)}" if reason_parts else f"NudeNet unsafe={unsafe_score:.2f}"
    else:
        reason = f"NudeNet safe={safe_score:.2f}"

    return ImageModerationResult(
        label=label,
        confidence=confidence,
        is_clean=not is_explicit,  # Inverted: True = safe, False = blocked
        raw_scores=scores,
        reason=reason,
    )
