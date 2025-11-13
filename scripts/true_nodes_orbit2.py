from datetime import datetime
from skyfield.api import Loader
import numpy as np
from astropy.coordinates import SkyCoord, BarycentricTrueEcliptic, CartesianRepresentation, ICRS
import astropy.units as u
from astropy.time import Time
from pathlib import Path

root = Path('c:/Users/user/synastry-ui')
loader = Loader(str(root))
eph = loader('de421.bsp')
from skyfield.api import load
ts = load.timescale()

def asc_desc(dt_iso):
    dt = datetime.fromisoformat(dt_iso)
    t_ast = Time(dt)
    t_sf = ts.tt_jd(t_ast.tt)
    earth = eph['earth']
    moon = eph['moon']
    astrom = earth.at(t_sf).observe(moon).apparent()
    pos = astrom.position.au
    vel = astrom.velocity.au_per_d
    r_icrs = SkyCoord(x=pos[0], y=pos[1], z=pos[2], representation_type=CartesianRepresentation, unit=u.au, frame=ICRS())
    v_icrs = SkyCoord(x=vel[0], y=vel[1], z=vel[2], representation_type=CartesianRepresentation, unit=u.au/u.day, frame=ICRS())
    r_ecl = r_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
    v_ecl = v_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
    r = np.array([r_ecl.cartesian.x.to(u.au).value, r_ecl.cartesian.y.to(u.au).value, r_ecl.cartesian.z.to(u.au).value])
    v = np.array([v_ecl.cartesian.x.to(u.au/u.day).value, v_ecl.cartesian.y.to(u.au/u.day).value, v_ecl.cartesian.z.to(u.au/u.day).value])
    h = np.cross(r, v)
    k = np.array([0.0, 0.0, 1.0])
    n = np.cross(k, h)
    if np.linalg.norm(n) == 0:
        asc_node = 0.0
    else:
        n_unit = n / np.linalg.norm(n)
        asc_node = (np.degrees(np.arctan2(n_unit[1], n_unit[0])) + 360.0) % 360.0
    desc_node = (asc_node + 180.0) % 360.0
    return asc_node, desc_node

for dt_iso in ['2016-04-17T05:00:00+00:00', '1987-01-26T05:00:00+00:00', '2025-01-26T05:00:00+00:00']:
    asc, desc = asc_desc(dt_iso)
    print(dt_iso, asc, desc)
