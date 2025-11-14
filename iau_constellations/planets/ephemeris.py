"""Skyfield helpers to compute apparent planetary positions."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict

import astropy.units as u
from astropy.coordinates import SkyCoord
from skyfield.api import Loader, load as skyfield_load

try:
    from app.resource_paths import get_resource_root
except ImportError:  # pragma: no cover - fallback for standalone usage
    get_resource_root = None

__all__ = ["load_ephemeris", "planet_positions_icrs"]


_PLANET_NAMES = {
    "Sun": "sun",
    "Moon": "moon",
    "Mercury": "mercury",
    "Venus": "venus",
    "Mars": "mars",
    "Jupiter": "jupiter barycenter",
    "Saturn": "saturn barycenter",
    "Uranus": "uranus barycenter",
    "Neptune": "neptune barycenter",
}


def load_ephemeris(data_dir: str | None = None):
    resolved_dir = data_dir
    if resolved_dir is None and get_resource_root is not None:
        resolved_dir = str(get_resource_root())
    if resolved_dir:
        loader = Loader(resolved_dir)
        return loader("de421.bsp")
    return skyfield_load("de421.bsp")


def _parse_datetime(dt_utc: str) -> datetime:
    if dt_utc.endswith("Z"):
        dt_utc = dt_utc[:-1] + "+00:00"
    dt = datetime.fromisoformat(dt_utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def planet_positions_icrs(dt_utc: str, eph=None) -> Dict[str, SkyCoord]:
    """Return apparent geocentric positions of major planets in ICRS."""

    dt = _parse_datetime(dt_utc)
    eph = eph or load_ephemeris()
    ts = skyfield_load.timescale()
    t = ts.utc(
        dt.year,
        dt.month,
        dt.day,
        dt.hour,
        dt.minute,
        dt.second + dt.microsecond / 1_000_000.0,
    )
    earth = eph["earth"]
    coordinates: Dict[str, SkyCoord] = {}
    for body, key in _PLANET_NAMES.items():
        astrometric = earth.at(t).observe(eph[key]).apparent()
        ra, dec, _distance = astrometric.radec()
        coordinates[body] = SkyCoord(ra=ra.to(u.deg), dec=dec.to(u.deg))
    return coordinates
