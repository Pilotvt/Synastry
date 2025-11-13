from pathlib import Path
import sys
import numpy as np
from skyfield.api import load
from skyfield import almanac
from astropy.coordinates import (
    SkyCoord,
    CartesianRepresentation,
    BarycentricTrueEcliptic,
    ICRS,
)
import astropy.units as u

ROOT = Path('c:/Users/user/synastry-ui')
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.constellations import resolve_constellation

loader = load
eph = loader(str(ROOT / 'de421.bsp'))
ts = loader.timescale()

start = ts.utc(1987, 1, 1)
end = ts.utc(2025, 12, 31)
phase_func = almanac.moon_phases(eph)
times, phases = almanac.find_discrete(start, end, phase_func)

earth = eph['earth']
moon = eph['moon']
sun = eph['sun']

def ang_diff(a: float, b: float) -> float:
    return abs(((a - b + 180.0) % 360.0) - 180.0)

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

records = []
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
        if diff_asc <= diff_desc:
            node_label = 'Rahu'
        else:
            node_label = 'Ketu'
        target_body = 'Sun'
        target_const = sun_const
        target_lon = sun_lon_deg
        kind = 'Solar'
    else:
        diff_asc = ang_diff(moon_lon_deg, asc_lon)
        diff_desc = ang_diff(moon_lon_deg, desc_lon)
        if diff_asc <= diff_desc:
            node_label = 'Rahu'
        else:
            node_label = 'Ketu'
        target_body = 'Moon'
        target_const = moon_const
        target_lon = moon_lon_deg
        kind = 'Lunar'

    records.append({
        'dt': dt,
        'kind': kind,
        'node': node_label,
        'node_const': target_const,
        'node_lon': target_lon,
        'target_body': target_body,
        'target_const': target_const,
        'target_lon': target_lon,
        'moon_lat': lat_deg,
    })

with open('eclipse_table.txt', 'w', encoding='utf-8') as out:
    for rec in records:
        dt = rec['dt']
        line = (
            f"{dt.date()} {str(dt.time())[:8]} | {rec['kind']} | Node {rec['node']} | "
            f"node_const {rec['node_const']:>11} | {rec['target_body']} const {rec['target_const']:>11} | "
            f"node_lon {rec['node_lon']:8.3f}° | {rec['target_body']} lon {rec['target_lon']:8.3f}° | "
            f"Moon lat {rec['moon_lat']:+.3f}°"
        )
        out.write(line + '\n')
