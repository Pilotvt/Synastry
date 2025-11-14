"""Compute ecliptic arcs of IAU constellations."""
from __future__ import annotations

from functools import lru_cache
from typing import List, Dict

import numpy as np
import astropy.units as u
from astropy.coordinates import BarycentricTrueEcliptic, SkyCoord

from ..frames.transforms import to_fk4_b1875
from ..boundaries.names_ru import NAMES_RU

__all__ = ["compute_ecliptic_arcs"]


@lru_cache(maxsize=1)
def compute_ecliptic_arcs(step_deg: float = 0.1) -> List[Dict[str, float | str]]:
    """Sample the ecliptic J2000 and return arcs grouped by IAU constellation."""

    lons = np.arange(0, 360 + step_deg, step_deg)
    coords = SkyCoord(
        lon=lons * u.deg,
        lat=np.zeros_like(lons) * u.deg,
        frame=BarycentricTrueEcliptic(equinox="J2000"),
    )
    fk4 = to_fk4_b1875(coords)
    codes = fk4.get_constellation(short_name=True)

    arcs: List[Dict[str, float | str]] = []
    start_lon = float(lons[0])
    current_code = codes[0]
    for lon, code in zip(lons[1:], codes[1:]):
        lon = float(lon)
        if code != current_code:
            arcs.append(
                {
                    "iau_code": current_code,
                    "iau_name_ru": NAMES_RU.get(current_code, current_code),
                    "lon_start_deg": start_lon,
                    "lon_end_deg": lon,
                }
            )
            start_lon = lon
            current_code = code
    arcs.append(
        {
            "iau_code": current_code,
            "iau_name_ru": NAMES_RU.get(current_code, current_code),
            "lon_start_deg": start_lon,
            "lon_end_deg": 360.0,
        }
    )
    return arcs
