from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone
import numpy as np
from skyfield.api import Loader
from skyfield import almanac
from astropy.coordinates import (
    SkyCoord,
    CartesianRepresentation,
    BarycentricTrueEcliptic,
    ICRS,
)
import astropy.units as u

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.constellations import resolve_constellation
from app.resource_paths import ephemeris_path, get_resource_root

RESOURCE_ROOT = get_resource_root()
loader = Loader(str(RESOURCE_ROOT))
eph = loader(str(ephemeris_path()))
ts = loader.timescale()

# Match ephemeris range used by the app (de440s default).
range_start_dt = datetime(1849, 12, 26, tzinfo=timezone.utc)
range_end_dt = datetime(2150, 1, 22, 23, 59, 59, tzinfo=timezone.utc)
phase_func = almanac.moon_phases(eph)

earth = eph['earth']
moon = eph['moon']
sun = eph['sun']

def ang_diff(a: float, b: float) -> float:
    return abs(((a - b + 180.0) % 360.0) - 180.0)

def constellation_from_ecliptic_lon(lon_deg: float) -> str:
    coord = SkyCoord(lon=lon_deg * u.deg, lat=0.0 * u.deg, frame=BarycentricTrueEcliptic(equinox='J2000'))
    icrs_coord = coord.transform_to('icrs')
    return resolve_constellation(float(icrs_coord.ra.deg), float(icrs_coord.dec.deg))

def node_longitudes(t):
    pos = earth.at(t).observe(moon).apparent()
    pos_icrs = pos.position.au
    vel_icrs = pos.velocity.au_per_d
    r_icrs = SkyCoord(CartesianRepresentation(pos_icrs[0] * u.au,
                                              pos_icrs[1] * u.au,
                                              pos_icrs[2] * u.au),
                      frame=ICRS())
    v_icrs = SkyCoord(CartesianRepresentation(vel_icrs[0] * u.au / u.day,
                                              vel_icrs[1] * u.au / u.day,
                                              vel_icrs[2] * u.au / u.day),
                      frame=ICRS())
    r_ecl = r_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
    v_ecl = v_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
    r_vec = np.array([
        r_ecl.cartesian.x.to(u.au).value,
        r_ecl.cartesian.y.to(u.au).value,
        r_ecl.cartesian.z.to(u.au).value,
    ])
    v_vec = np.array([
        v_ecl.cartesian.x.to(u.au / u.day).value,
        v_ecl.cartesian.y.to(u.au / u.day).value,
        v_ecl.cartesian.z.to(u.au / u.day).value,
    ])
    h_vec = np.cross(r_vec, v_vec)
    node_vec = np.cross([0.0, 0.0, 1.0], h_vec)
    if np.linalg.norm(node_vec) == 0.0:
        asc_lon = 0.0
    else:
        n_unit = node_vec / np.linalg.norm(node_vec)
        asc_lon = (np.degrees(np.arctan2(n_unit[1], n_unit[0])) + 360.0) % 360.0
    desc_lon = (asc_lon + 180.0) % 360.0
    return asc_lon, desc_lon

with open('eclipse_table.txt', 'w', encoding='utf-8') as out:
    for year in range(range_start_dt.year, range_end_dt.year + 1):
        year_start = datetime(year, 1, 1, tzinfo=timezone.utc)
        year_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        if year_end <= range_start_dt or year_start >= range_end_dt:
            continue

        chunk_start_dt = max(year_start, range_start_dt)
        chunk_end_dt = min(year_end, range_end_dt)

        # Back off from the end if Skyfield probes past kernel bounds.
        while True:
            try:
                chunk_start = ts.utc(chunk_start_dt)
                chunk_end = ts.utc(chunk_end_dt)
                times, phases = almanac.find_discrete(chunk_start, chunk_end, phase_func)
                break
            except Exception as exc:
                if "EphemerisRangeError" not in type(exc).__name__:
                    raise
                chunk_end_dt -= timedelta(days=1)
                if chunk_end_dt <= chunk_start_dt:
                    times, phases = [], []
                    break

        for t, phase in zip(times, phases):
            phase_idx = int(phase)
            if phase_idx not in (0, 2):
                continue

            moon_pos = earth.at(t).observe(moon).apparent()
            lat, lon, _ = moon_pos.ecliptic_latlon()
            lat_deg = float(lat.degrees)
            if abs(lat_deg) > 1.5:
                continue
            dt = t.utc_datetime()

            asc_lon, desc_lon = node_longitudes(t)

            sun_pos = earth.at(t).observe(sun).apparent()
            sun_lon_deg = float(sun_pos.ecliptic_latlon()[1].degrees)
            ra_sun, dec_sun, _ = sun_pos.radec()
            sun_const = resolve_constellation(float(ra_sun.degrees), float(dec_sun.degrees))

            moon_lon_deg = float(lon.degrees)
            ra_moon, dec_moon, _ = moon_pos.radec()
            moon_const = resolve_constellation(float(ra_moon.degrees), float(dec_moon.degrees))

            if phase_idx == 0:
                diff_asc = ang_diff(sun_lon_deg, asc_lon)
                diff_desc = ang_diff(sun_lon_deg, desc_lon)
                node_label = 'Rahu' if diff_asc <= diff_desc else 'Ketu'
                node_lon = asc_lon if node_label == 'Rahu' else desc_lon
                target_body = 'Sun'
                target_const = sun_const
                target_lon = sun_lon_deg
                kind = 'Solar'
            else:
                diff_asc = ang_diff(moon_lon_deg, asc_lon)
                diff_desc = ang_diff(moon_lon_deg, desc_lon)
                node_label = 'Rahu' if diff_asc <= diff_desc else 'Ketu'
                node_lon = asc_lon if node_label == 'Rahu' else desc_lon
                target_body = 'Moon'
                target_const = moon_const
                target_lon = moon_lon_deg
                kind = 'Lunar'

            node_const = constellation_from_ecliptic_lon(node_lon)

            line = (
                f"{dt.date()} {str(dt.time())[:8]} | {kind} | Node {node_label} | "
                f"node_const {node_const:>11} | {target_body} const {target_const:>11} | "
                f"node_lon {node_lon:8.3f}° | {target_body} lon {target_lon:8.3f}° | "
                f"Moon lat {lat_deg:+.3f}°"
            )
            out.write(line + '\n')
