"""Helpers to work with IAU constellation boundary segments."""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Dict, List

from .load_iau_boundaries import BoundarySegment, load_boundary_segments

__all__ = ["segments_by_constellation"]


def segments_by_constellation(path: str | Path) -> Dict[str, List[BoundarySegment]]:
    """Load the Stellarium boundary file and group segments by constellation code."""

    segments = load_boundary_segments(path)
    grouped: Dict[str, List[BoundarySegment]] = defaultdict(list)
    for seg in segments:
        grouped[seg.left_iau].append(seg)
        grouped[seg.right_iau].append(
            BoundarySegment(
                ra1_deg=seg.ra2_deg,
                dec1_deg=seg.dec2_deg,
                ra2_deg=seg.ra1_deg,
                dec2_deg=seg.dec1_deg,
                left_iau=seg.right_iau,
                right_iau=seg.left_iau,
            )
        )
    return dict(grouped)
