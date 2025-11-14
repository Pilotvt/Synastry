# Small test harness to call compute_chart and print debug_info for a sample date
# Usage: python scripts/test_nodes.py
from datetime import datetime
import pytz
import json
import sys
import os

# ensure repository root is on sys.path so `app` package imports succeed when run as script
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

# adjust imports to find app package
from app.schemas import ChartRequest
from app.jyotish import compute_chart
from iau_constellations.planets.ephemeris import load_ephemeris, planet_positions_icrs
import numpy as np
from astropy.time import Time
from astropy.coordinates import BarycentricTrueEcliptic
import astropy.units as u
import traceback
try:
    from scipy.optimize import brentq
except Exception:
    brentq = None


def compute_nodes_via_positions(dt_iso: str, search_days: float = 30.0):
    """Standalone positions-based node finder for debugging.
    dt_iso: ISO string (astropy Time compatible), search_days: +/- days to search
    Returns (rahu_lon, ketu_lon, info)
    """
    try:
        eph = load_ephemeris('c:/Users/user/Git/Synastry')
    except Exception as e:
        return None, None, {'error': f'eph load failed: {e}'}

    # base astropy Time
    try:
        t0 = Time(dt_iso)
    except Exception:
        try:
            t0 = Time(datetime.fromisoformat(dt_iso))
        except Exception as e:
            return None, None, {'error': f'time parse failed: {e}'}

    step = 0.5
    offsets = np.arange(-search_days, search_days + step, step)
    lats = []
    times = []
    try:
        for off in offsets:
            t_sample = t0 + off * u.day
            iso = t_sample.iso
            coords = planet_positions_icrs(iso, eph=eph)
            moon = coords.get('Moon')
            if moon is None:
                return None, None, {'error': 'Moon not found in positions'}
            mecl = moon.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
            lats.append(float(mecl.lat.to(u.deg).value))
            times.append(t_sample)
    except Exception as e:
        return None, None, {'error': 'sampling failed', 'exc': traceback.format_exc()}

    intervals = []
    for i in range(len(offsets) - 1):
        a, b = lats[i], lats[i + 1]
        if a == 0.0:
            intervals.append((offsets[i], offsets[i]))
        elif a * b < 0:
            intervals.append((offsets[i], offsets[i + 1]))

    if not intervals:
        return None, None, {'error': 'no sign changes found', 'lats_sampled': lats[:10]}

    chosen = min(intervals, key=lambda iv: min(abs(iv[0]), abs(iv[1])))

    def f(days_off: float) -> float:
        t_ast = t0 + days_off * u.day
        iso = t_ast.iso
        coords = planet_positions_icrs(iso, eph=eph)
        moon = coords.get('Moon')
        mecl = moon.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
        return float(mecl.lat.to(u.deg).value)

    a0, b0 = chosen
    try:
        if brentq is not None:
            root = brentq(f, a0, b0, xtol=1e-7, maxiter=200)
        else:
            fa, fb = f(a0), f(b0)
            A, B = a0, b0
            for _ in range(100):
                M = 0.5 * (A + B)
                fm = f(M)
                if abs(fm) < 1e-9:
                    break
                if fa * fm <= 0:
                    B, fb = M, fm
                else:
                    A, fa = M, fm
            root = 0.5 * (A + B)
    except Exception as e:
        return None, None, {'error': 'root find failed', 'exc': traceback.format_exc()}

    t_root = t0 + root * u.day
    iso_root = t_root.iso
    coords = planet_positions_icrs(iso_root, eph=eph)
    moon = coords.get('Moon')
    mecl = moon.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
    # cartesian components may or may not have astropy units; handle both
    def comp_value(q):
        try:
            return float(q.to(u.au).value)
        except Exception:
            try:
                return float(q.value)
            except Exception:
                return float(q)

    x = comp_value(mecl.cartesian.x)
    y = comp_value(mecl.cartesian.y)
    asc_node_lon = (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0
    desc_node_lon = (asc_node_lon + 180.0) % 360.0
    return asc_node_lon, desc_node_lon, {'root_offset_days': root, 'iso_root': iso_root}


def run_test(dt_iso: str, lat: float, lon: float, elev: float = 0.0):
    req = ChartRequest(datetime_iso=dt_iso, latitude=lat, longitude=lon, elevation_m=elev, house_system='Porphyry')
    try:
        resp = compute_chart(req)
        dbg = resp.debug_info if hasattr(resp, 'debug_info') else getattr(resp, 'debug_info', None)
        print(json.dumps(dbg, ensure_ascii=False, indent=2))
    except Exception as e:
        print('ERROR running compute_chart:', repr(e), file=sys.stderr)


if __name__ == '__main__':
    # 1) aware datetime in Europe/Moscow
    run_test('1987-01-26T08:00:00+03:00', 55.7558, 37.6173)
    # 2) naive datetime (no tz) - should be interpreted as local to lon by heuristic
    run_test('1987-01-26T08:00:00', 55.7558, 37.6173)
    print('\nDirect positions-based node test:')
    r, k, info = compute_nodes_via_positions('1987-01-26T05:00:00+00:00', search_days=60.0)
    print('Rahu, Ketu, info:')
    print(r, k)
    print(json.dumps(info, ensure_ascii=False, indent=2))
