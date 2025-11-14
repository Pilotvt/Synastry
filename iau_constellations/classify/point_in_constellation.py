"""Classify coordinates into IAU constellations."""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List

import astropy.units as u
from astropy.coordinates import SkyCoord

from ..boundaries.names_ru import NAMES_RU
from ..frames.transforms import to_fk4_b1875
from ..planets.ephemeris import planet_positions_icrs

__all__ = ["classify_iau", "classify_planets"]


def classify_iau(coord_icrs: SkyCoord) -> Dict[str, object]:
    fk4_coord = to_fk4_b1875(coord_icrs)
    iau_code = fk4_coord.get_constellation(short_name=True)
    return {
        "iau_code": iau_code,
        "iau_name_ru": NAMES_RU.get(iau_code, iau_code),
        "ra_deg_b1875": fk4_coord.ra.to(u.deg).value,
        "dec_deg_b1875": fk4_coord.dec.to(u.deg).value,
    }


def classify_planets(dt_utc: str) -> List[Dict[str, object]]:
    positions = planet_positions_icrs(dt_utc)
    results: List[Dict[str, object]] = []
    for body, coord in positions.items():
        info = classify_iau(coord)
        info["body"] = body
        results.append(info)
    return results
