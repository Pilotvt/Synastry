"""Utilities to parse the IAU constellation boundary segments."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List

import pandas as pd

__all__ = ["BoundarySegment", "load_boundary_segments"]

DATA_URL = (
    "https://raw.githubusercontent.com/Stellarium/stellarium-data/master/constellations_boundaries.dat"
)

@dataclass(frozen=True)
class BoundarySegment:
    """Single boundary segment defined in FK4(B1875)."""

    ra1_deg: float
    dec1_deg: float
    ra2_deg: float
    dec2_deg: float
    left_iau: str
    right_iau: str


def _parse_ra(value: str) -> float:
    """Convert hours representation to degrees.

    The file stores RA in decimal hours (0..24).  We simply multiply by 15.
    """

    return float(value) * 15.0


def _parse_dec(value: str) -> float:
    return float(value)


def _iter_segments(lines: Iterable[str]) -> Iterable[BoundarySegment]:
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 6:
            raise ValueError(f"Unexpected line format: {line}")
        ra1, dec1, ra2, dec2, left, right = parts
        yield BoundarySegment(
            ra1_deg=_parse_ra(ra1),
            dec1_deg=_parse_dec(dec1),
            ra2_deg=_parse_ra(ra2),
            dec2_deg=_parse_dec(dec2),
            left_iau=left,
            right_iau=right,
        )


def load_boundary_segments(path: str | Path) -> List[BoundarySegment]:
    """Load the IAU boundary segments from the given path.

    Parameters
    ----------
    path: str or Path
        Path to ``constellations_boundaries.dat``.

    Returns
    -------
    list[BoundarySegment]
        Parsed segments in FK4(B1875) coordinates.
    """

    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(
            f"Boundary file '{p}' not found. Download it from {DATA_URL} and place it into the data/ folder."
        )
    with p.open("r", encoding="utf-8") as fh:
        segments = list(_iter_segments(fh))
    return segments


def segments_to_dataframe(segments: Iterable[BoundarySegment]) -> pd.DataFrame:
    """Convert an iterable of segments to a pandas DataFrame."""

    data = [
        {
            "ra1_deg": seg.ra1_deg,
            "dec1_deg": seg.dec1_deg,
            "ra2_deg": seg.ra2_deg,
            "dec2_deg": seg.dec2_deg,
            "left_iau": seg.left_iau,
            "right_iau": seg.right_iau,
        }
        for seg in segments
    ]
    return pd.DataFrame(data)
