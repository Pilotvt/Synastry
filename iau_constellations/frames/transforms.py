"""Frame transformation helpers."""
from __future__ import annotations

import astropy.units as u
from astropy.coordinates import FK4, SkyCoord, BarycentricTrueEcliptic

__all__ = ["to_fk4_b1875", "to_ecliptic_j2000"]


_DEF_FK4 = FK4(equinox="B1875")
_DEF_ECL = BarycentricTrueEcliptic(equinox="J2000")


def to_fk4_b1875(coord: SkyCoord) -> SkyCoord:
    """Transform an arbitrary coordinate to FK4(B1875)."""

    return coord.transform_to(_DEF_FK4)


def to_ecliptic_j2000(coord: SkyCoord) -> SkyCoord:
    """Transform an arbitrary coordinate to ecliptic J2000."""

    return coord.transform_to(_DEF_ECL)
