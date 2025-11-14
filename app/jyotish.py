# Core Jyotish chart computation logic
# Uses: skyfield, jplephem, astropy
from skyfield.api import load, Topos
from datetime import datetime, timedelta
import pytz
import json
from .constellations import resolve_constellation
from .north_indian import north_indian_layout, SIGNS, PLANET_ABBR
from .schemas import (
    ChartRequest,
    ChartResponse,
    Planet,
    AscendantMC,
    House,
    NorthIndianLayout,
    NorthIndianBox,
    AspectLabel,
    PlanetConstellation,
    ConstellationArc,
)
from iau_constellations.classify.point_in_constellation import classify_planets
from iau_constellations.classify.ecliptic_arcs_j2000 import compute_ecliptic_arcs
from astropy.coordinates import SkyCoord, EarthLocation, AltAz, BarycentricTrueEcliptic
import astropy.units as u
import numpy as np
try:
    from scipy.optimize import brentq
except Exception:
    brentq = None
from iau_constellations.planets.ephemeris import load_ephemeris, planet_positions_icrs
from astropy.time import Time
from astropy.coordinates import CartesianRepresentation
import os
from .nodes import calculate_nodes

import json
from pathlib import Path
from .resource_paths import resource_path, RESOURCE_ROOT

# Try to load precomputed arcs from file `ephe/iau_arcs.json`; if not present, compute once and save
RESOURCE_ROOT_STR = str(RESOURCE_ROOT)
DE421_PATH = resource_path('de421.bsp')
_iau_path = resource_path('ephe', 'iau_arcs.json')
try:
    if _iau_path.exists():
        with open(_iau_path, 'r', encoding='utf-8') as f:
            IAU_ECLIPTIC_ARCS = json.load(f)
    else:
        IAU_ECLIPTIC_ARCS = compute_ecliptic_arcs()
        # ensure directory exists
        _iau_path.parent.mkdir(parents=True, exist_ok=True)
        with open(_iau_path, 'w', encoding='utf-8') as f:
            json.dump(IAU_ECLIPTIC_ARCS, f, ensure_ascii=False, indent=2)
except Exception:
    # fallback empty
    IAU_ECLIPTIC_ARCS = []

# Build a mapping from iau_code -> russian name if available
IAU_CODE_TO_RU: dict = {}
for arc in IAU_ECLIPTIC_ARCS:
    code = arc.get("iau_code") or ''
    name_ru = arc.get("iau_name_ru") or ''
    if code:
        IAU_CODE_TO_RU[code] = name_ru

VEDIC_ASPECT_OFFSETS = {
    "Su": [6],  # 7th from itself
    "Mo": [6],  # 7th from itself
    "Me": [6],  # 7th from itself
    "Ve": [6],  # 7th from itself
    "Ma": [3, 6, 7],  # 4th, 7th, 8th
    "Ju": [4, 6, 8],  # 5th, 7th, 9th
    "Sa": [2, 6, 9],  # 3rd, 7th, 10th
    "Ra": [4, 6, 8],  # По школе Пурушоттама # 7th from itself, 5th, 9th
    "Ke": [6],  # По школе Пурушоттама # 7th from itself
}

SIGN_CODES = {s: i+1 for i, s in enumerate(SIGNS)}

# legacy helpers removed

# Main chart computation
def compute_chart(data: ChartRequest) -> ChartResponse:
    rahu_is_desc = False  # всегда определена
    # Parse datetime
    import pytz
    dt = datetime.fromisoformat(data.datetime_iso)
    # Если дата содержит offset, dt уже aware
    used_iana_tz = False
    used_iana_name = None
    used_approx_tz = False
    used_approx_offset = 0
    if dt.tzinfo is None:
        # Попробуем определить IANA timezone по координатам (timezonefinder), если доступна
        try:
            from timezonefinder import TimezoneFinder
            tf = TimezoneFinder()
            tzname = tf.timezone_at(lng=(data.longitude or 0.0), lat=(data.latitude or 0.0))
            if tzname:
                tz = pytz.timezone(tzname)
                dt = tz.localize(dt)
                used_iana_tz = True
                used_iana_name = tzname
            else:
                raise Exception('tz not found')
        except Exception:
            # fallback: приближённая эвристика по долготе 15° = 1 час
            try:
                approx_offset_hours = int(round((data.longitude or 0.0) / 15.0))
                offset_minutes = approx_offset_hours * 60
                dt = dt.replace(tzinfo=pytz.FixedOffset(offset_minutes))
                used_approx_tz = True
                used_approx_offset = offset_minutes
            except Exception:
                dt = dt.replace(tzinfo=pytz.UTC)
                used_approx_tz = False
                used_approx_offset = 0
    else:
        used_iana_tz = False
        used_iana_name = None
    dt_utc = dt.astimezone(pytz.UTC)
    # compute JD using astropy Time
    t_ast = Time(dt_utc)
    jd = float(t_ast.jd)
    # initialize flags
    used_constellational_planets = False

    # Ascendant & MC
    def find_constellational_ascendant(dt_utc: datetime, lat: float, lon: float, elevation_m: float = 0.0):
        """Find the ecliptic longitude (J2000) where the ecliptic intersects the eastern horizon.

        Algorithm:
        - coarse scan λ in steps to find sign changes of altitude h(λ)
        - use brentq on intervals with sign change to find roots
        - filter roots by azimuth ∈ [60°, 120°] (prefer those); pick nearest to 90° if multiple

        Returns: (lon_deg, iau_code)
        """
        location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=elevation_m * u.m)

        altaz_frame = AltAz(obstime=dt_utc.replace(tzinfo=pytz.UTC), location=location)

        def alt_at_lambda(lambda_deg: float) -> float:
            c = SkyCoord(lon=lambda_deg * u.deg, lat=0 * u.deg, frame=BarycentricTrueEcliptic(equinox='J2000'))
            icrs = c.transform_to('icrs')
            azf = icrs.transform_to(altaz_frame)
            return float(azf.alt.deg)

        def az_at_lambda(lambda_deg: float) -> float:
            c = SkyCoord(lon=lambda_deg * u.deg, lat=0 * u.deg, frame=BarycentricTrueEcliptic(equinox='J2000'))
            icrs = c.transform_to('icrs')
            azf = icrs.transform_to(altaz_frame)
            return float(azf.az.deg)

        alt_cache: dict[float, float] = {}

        def alt_cached(lambda_deg: float) -> float:
            key = round(lambda_deg % 360.0, 6)
            if key not in alt_cache:
                alt_cache[key] = alt_at_lambda(lambda_deg)
            return alt_cache[key]

        # Coarse scan in 5° steps to bracket the horizon crossing quickly
        step_coarse = 5.0
        lons = np.arange(0.0, 360.0 + step_coarse, step_coarse)
        alts = np.array([alt_cached(float(L)) for L in lons])

        intervals = []
        for i in range(len(lons) - 1):
            a, b = alts[i], alts[i + 1]
            if a == 0.0:
                intervals.append((lons[i], lons[i]))
            elif a * b < 0:
                intervals.append((lons[i], lons[i + 1]))

        if not intervals:
            # Fallback to a finer search if coarse scan missed the crossing
            step_fine = 1.0
            lons = np.arange(0.0, 360.0 + step_fine, step_fine)
            alts = np.array([alt_cached(float(L)) for L in lons])
            for i in range(len(lons) - 1):
                a, b = alts[i], alts[i + 1]
                if a == 0.0:
                    intervals.append((lons[i], lons[i]))
                elif a * b < 0:
                    intervals.append((lons[i], lons[i + 1]))

        roots = []
        for (la, lb) in intervals:
            try:
                if la == lb:
                    root = la
                else:
                    fa, fb = alt_cached(la), alt_cached(lb)
                    if fa * fb > 0:
                        continue
                    if brentq is not None:
                        root = brentq(lambda x: alt_cached(x), la, lb, xtol=1e-6, maxiter=40)
                    else:
                        a0, b0 = la, lb
                        fa0, fb0 = fa, fb
                        for _ in range(32):
                            m = 0.5 * (a0 + b0)
                            fm = alt_cached(m)
                            if abs(fm) < 1e-6:
                                a0 = b0 = m
                                break
                            if fa0 * fm <= 0:
                                b0, fb0 = m, fm
                            else:
                                a0, fa0 = m, fm
                        root = 0.5 * (a0 + b0)
                az = az_at_lambda(root)
                az = az % 360.0
                roots.append((root % 360.0, az))
            except Exception:
                continue

        # filter roots by azimuth window 60..120
        candidates = [r for r in roots if 60.0 <= r[1] <= 120.0]
        if not candidates and roots:
            # pick root with az closest to 90
            candidates = sorted(roots, key=lambda x: abs(((x[1] - 90 + 180) % 360) - 180))

        if candidates:
            chosen_lon = float(candidates[0][0])
        else:
            # fallback: choose lambda with altitude closest to zero
            idx = int(np.argmin(np.abs(alts)))
            chosen_lon = float(lons[idx])

        chosen_coord = SkyCoord(lon=chosen_lon * u.deg, lat=0 * u.deg, frame=BarycentricTrueEcliptic(equinox='J2000'))
        icrs_chosen = chosen_coord.transform_to('icrs')
        ra_deg = icrs_chosen.ra.deg
        dec_deg = icrs_chosen.dec.deg
        iau_code = resolve_constellation(ra_deg, dec_deg)
        return chosen_lon, iau_code

    # Use astropy+iau_constellations to compute ascendant as ecliptic J2000 longitude
    asc_lon_j2000, _ = find_constellational_ascendant(dt_utc, data.latitude, data.longitude, data.elevation_m)
    # use cached IAU arcs
    ecl_arcs = IAU_ECLIPTIC_ARCS

    def iau_for_lon(lambda_deg: float):
        # lambda_deg in 0..360
        lam = float(lambda_deg % 360.0)
        for a in ecl_arcs:
            start = float(a.get("lon_start_deg", 0.0)) % 360.0
            end = float(a.get("lon_end_deg", 0.0)) % 360.0
            if start <= end:
                inside = (lam >= start and lam < end)
            else:
                inside = (lam >= start or lam < end)
            if inside:
                return a.get("iau_code") or a.get("iau_name_ru"), a.get("iau_name_ru")
        # fallback: use astropy resolve
        c = SkyCoord(lon=lam * u.deg, lat=0 * u.deg, frame=BarycentricTrueEcliptic(equinox='J2000'))
        icrs_c = c.transform_to('icrs')
        name = resolve_constellation(float(icrs_c.ra.deg), float(icrs_c.dec.deg))
        return name, name

    # No forced overrides — use official IAU arcs mapping
    def iau_for_lon_with_overrides(lambda_deg: float):
        lam = float(lambda_deg % 360.0)
        code, name_ru = iau_for_lon(lam)
        return code, name_ru

    asc_iau_code, asc_iau_name_ru = iau_for_lon_with_overrides(asc_lon_j2000)
    # Determine traditional sign by ecliptic longitude (0..360 -> Ar/Ta/..)
    # Map IAU constellation names to the 12 zodiac sign codes (treat Ophiuchus as Scorpio)
    # Map IAU short codes (as used in IAU arcs, e.g. 'Ari','Tau','Psc') to the 12-sign codes used by the layout.
    # Also treat Ophiuchus as Scorpio for the purposes of sign mapping.
    IAU_TO_SIGN = {
        'Ari': 'Ar',
        'Tau': 'Ta',
        'Gem': 'Ge',
        'Cnc': 'Cn',
        'Leo': 'Le',
        'Vir': 'Vi',
        'Lib': 'Li',
        'Sco': 'Sc',
        'Oph': 'Sc',
        'Sgr': 'Sg',
        'Cap': 'Cp',
        'Aqr': 'Aq',
        'Psc': 'Pi',
    }

    # Map IAU constellation code to zodiac sign. Do NOT fallback to simple lon/30 mapping.
    # If mapping is missing, default to the first sign ('Ar') to avoid using raw lon/30 logic.
    asc_mapped_sign = IAU_TO_SIGN.get(asc_iau_code, SIGNS[0])
    asc = AscendantMC(sign=asc_mapped_sign, degree=asc_lon_j2000 % 30, lon_sidereal=asc_lon_j2000, constellation_iau=asc_iau_code, constellation_name_ru=asc_iau_name_ru)
    # --- Begin J2000 pipeline helpers ---
    def get_planet_lambdas_j2000(dt_iso: str):
        eph = load_ephemeris(RESOURCE_ROOT_STR)
        coords = planet_positions_icrs(dt_iso, eph=eph)
        lambdas: dict = {}
        for body, coord in coords.items():
            ecl = coord.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
            lambdas[body] = float(ecl.lon.to(u.deg).value % 360.0)
        return lambdas, eph

    def compute_nodes_from_orbital_plane(eph, dt_iso: str):
        from skyfield.api import Loader, load as skyfield_load

        loader = Loader(RESOURCE_ROOT_STR)
        eph_sf = loader(str(DE421_PATH))
        ts = skyfield_load.timescale()
        # dt_iso may be a datetime, astropy Time, or iso string. Normalize to astropy Time
        if isinstance(dt_iso, Time):
            t_ast = dt_iso
        else:
            try:
                # if it's a string, try parsing to datetime first (handles timezone offsets)
                if isinstance(dt_iso, str):
                    dt_parsed = datetime.fromisoformat(dt_iso)
                else:
                    dt_parsed = dt_iso
                t_ast = Time(dt_parsed)
            except Exception:
                t_ast = Time(dt_iso)
        # convert astropy Time to python datetime and then to skyfield Time
        try:
            t_dt = t_ast.to_datetime()
            t = ts.from_datetime(t_dt)
        except Exception:
            t = ts.utc(*t_ast.utc[:6])
        earth = eph_sf['earth']
        moon = eph_sf['moon']
        astrom = earth.at(t).observe(moon).apparent()
        pos = astrom.position.au
        vel = astrom.velocity.au_per_d
        from astropy.coordinates import ICRS
        r_icrs = SkyCoord(x=pos[0], y=pos[1], z=pos[2], representation_type=CartesianRepresentation, unit=u.au, frame=ICRS())
        v_icrs = SkyCoord(x=vel[0], y=vel[1], z=vel[2], representation_type=CartesianRepresentation, unit=(u.au/u.day), frame=ICRS())
        r_ecl = r_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
        v_ecl = v_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
        r = np.array([r_ecl.cartesian.x.to(u.au).value, r_ecl.cartesian.y.to(u.au).value, r_ecl.cartesian.z.to(u.au).value])
        v = np.array([v_ecl.cartesian.x.to(u.au/u.day).value, v_ecl.cartesian.y.to(u.au/u.day).value, v_ecl.cartesian.z.to(u.au/u.day).value])
        h = np.cross(r, v)
        k = np.array([0.0, 0.0, 1.0])
        n = np.cross(k, h)
        if np.linalg.norm(n) == 0:
            asc_node_lon = 0.0
        else:
            n_unit = n / np.linalg.norm(n)
            asc_node_lon = (np.degrees(np.arctan2(n_unit[1], n_unit[0])) + 360.0) % 360.0
        desc_node_lon = (asc_node_lon + 180.0) % 360.0
        return asc_node_lon, desc_node_lon

    def compute_nodes_from_moon_lat_zero(eph, dt_iso: str, search_days: float = 30.0):
        """Fallback: find the nearest zero-crossing of the Moon's ecliptic latitude (ascending node).
        Search +/- search_days around dt_iso with sampling, find a sign change and refine with brentq/bisection.
        Returns (asc_node_lon, desc_node_lon) in degrees or (None, None) on failure.
        """
        try:
            from skyfield.api import Loader, load as skyfield_load
            loader = Loader(RESOURCE_ROOT_STR)
            eph_sf = loader(str(DE421_PATH))
            ts = skyfield_load.timescale()
            earth = eph_sf['earth']
            moon = eph_sf['moon']

            # Normalize dt_iso to astropy Time (accept datetime, string, or Time)
            if isinstance(dt_iso, Time):
                base_time = dt_iso
            else:
                try:
                    if isinstance(dt_iso, str):
                        dt_parsed = datetime.fromisoformat(dt_iso)
                    else:
                        dt_parsed = dt_iso
                    base_time = Time(dt_parsed)
                except Exception:
                    base_time = Time(dt_iso)

            # helper: given offset days, return ecliptic latitude in degrees
            def lat_at_offset(days_offset: float) -> float:
                t_ast = base_time + days_offset * u.day
                try:
                    t_dt = t_ast.to_datetime()
                    t_sf = ts.from_datetime(t_dt)
                except Exception:
                    t_sf = ts.utc(*t_ast.utc[:6])
                astrom = earth.at(t_sf).observe(moon).apparent()
                pos = astrom.position.au
                from astropy.coordinates import ICRS
                r_icrs = SkyCoord(x=pos[0], y=pos[1], z=pos[2], representation_type=CartesianRepresentation, unit=u.au, frame=ICRS())
                r_ecl = r_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
                return float(r_ecl.lat.to(u.deg).value)

            # coarse sampling
            step = 0.5
            offsets = np.arange(-search_days, search_days + step, step)
            lats = [lat_at_offset(off) for off in offsets]
            # find nearest sign change interval around 0 offset
            intervals = []
            for i in range(len(offsets) - 1):
                a, b = lats[i], lats[i + 1]
                if a == 0.0:
                    intervals.append((offsets[i], offsets[i]))
                elif a * b < 0:
                    intervals.append((offsets[i], offsets[i + 1]))

            if not intervals:
                return None, None

            # choose interval nearest to zero offset
            chosen = min(intervals, key=lambda iv: min(abs(iv[0]), abs(iv[1])))

            def f(days_off: float) -> float:
                return lat_at_offset(days_off)

            if chosen[0] == chosen[1]:
                root_offset = chosen[0]
            else:
                a0, b0 = chosen
                try:
                    if brentq is not None:
                        root_offset = brentq(f, a0, b0, xtol=1e-6, maxiter=100)
                    else:
                        # bisection fallback
                        fa, fb = f(a0), f(b0)
                        A, B = a0, b0
                        for _ in range(60):
                            M = 0.5 * (A + B)
                            fm = f(M)
                            if abs(fm) < 1e-8:
                                break
                            if fa * fm <= 0:
                                B, fb = M, fm
                            else:
                                A, fa = M, fm
                        root_offset = 0.5 * (A + B)
                except Exception:
                    return None, None

            # now compute longitude at root_offset
            t_root_ast = base_time + root_offset * u.day
            t_root_sf = ts.utc(*t_root_ast.utc[:6])
            astrom = earth.at(t_root_sf).observe(moon).apparent()
            pos = astrom.position.au
            from astropy.coordinates import ICRS
            r_icrs = SkyCoord(x=pos[0], y=pos[1], z=pos[2], representation_type=CartesianRepresentation, unit=u.au, frame=ICRS())
            r_ecl = r_icrs.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
            x = float(r_ecl.cartesian.x.to(u.au).value)
            y = float(r_ecl.cartesian.y.to(u.au).value)
            lon_at_root = (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0
            # determine whether this root is ascending (lat increases through zero)
            try:
                eps = 1e-3  # ~1.44 minutes
                lat_before = lat_at_offset(root_offset - eps)
                lat_after = lat_at_offset(root_offset + eps)
                ascending = (lat_after - lat_before) > 0
            except Exception:
                ascending = True

            if ascending:
                asc_node_lon = lon_at_root
                desc_node_lon = (asc_node_lon + 180.0) % 360.0
            else:
                desc_node_lon = lon_at_root
                asc_node_lon = (desc_node_lon + 180.0) % 360.0
            return asc_node_lon, desc_node_lon
        except Exception:
            return None, None

    def compute_nodes_from_moon_lat_via_positions(eph, dt_iso, search_days: float = 30.0, return_info: bool = False):
        """Compute lunar nodes by bracketing the Moon's ecliptic latitude zero-crossing.
        Uses an expanding search with cached position evaluations instead of dense sampling.
        """
        try:
            if isinstance(dt_iso, Time):
                base_time = dt_iso
            else:
                try:
                    dt_parsed = datetime.fromisoformat(dt_iso) if isinstance(dt_iso, str) else dt_iso
                    base_time = Time(dt_parsed)
                except Exception:
                    base_time = Time(dt_iso)

            eph_local = eph if eph is not None else load_ephemeris(RESOURCE_ROOT_STR)

            state_cache = {}

            def moon_state(days_off: float):
                key = round(float(days_off), 6)
                cached = state_cache.get(key)
                if cached is not None:
                    return cached
                t_ast = base_time + days_off * u.day
                iso = t_ast.iso
                coords = planet_positions_icrs(iso, eph=eph_local)
                moon_coord = coords.get('Moon')
                if moon_coord is None:
                    raise RuntimeError('Moon not found')
                mecl = moon_coord.transform_to(BarycentricTrueEcliptic(equinox='J2000'))
                lat_val = float(mecl.lat.to(u.deg).value)
                state = (lat_val, mecl, iso)
                state_cache[key] = state
                return state

            lat0, _, _ = moon_state(0.0)
            if abs(lat0) < 1e-9:
                root_offset = 0.0
            else:
                step = 0.5
                max_steps = max(1, int(np.ceil(search_days / step)))
                bracket = None
                for k in range(1, max_steps + 1):
                    off = k * step
                    lat_pos, _, _ = moon_state(off)
                    if lat0 * lat_pos <= 0:
                        bracket = (0.0, off)
                        break
                    lat_neg, _, _ = moon_state(-off)
                    if lat0 * lat_neg <= 0:
                        bracket = (-off, 0.0)
                        break
                if bracket is None:
                    offsets = np.arange(-search_days, search_days + step, step)
                    for i in range(len(offsets) - 1):
                        lat_a, _, _ = moon_state(offsets[i])
                        lat_b, _, _ = moon_state(offsets[i + 1])
                        if lat_a == 0.0:
                            bracket = (offsets[i], offsets[i])
                            break
                        if lat_a * lat_b < 0:
                            bracket = (offsets[i], offsets[i + 1])
                            break
                if bracket is None:
                    if return_info:
                        return None, None, {"error": "bracket_not_found"}
                    return None, None

                a0, b0 = bracket
                if a0 == b0:
                    root_offset = a0
                else:
                    def lat_func(off: float) -> float:
                        return moon_state(off)[0]

                    fa, fb = lat_func(a0), lat_func(b0)
                    if fa * fb > 0:
                        if return_info:
                            return None, None, {"error": "bracket_same_sign"}
                        return None, None
                    if brentq is not None:
                        root_offset = brentq(lat_func, a0, b0, xtol=1e-6, maxiter=40)
                    else:
                        for _ in range(40):
                            mid = 0.5 * (a0 + b0)
                            fm = lat_func(mid)
                            if abs(fm) < 1e-8 or abs(b0 - a0) < 1e-6:
                                a0 = b0 = mid
                                break
                            if fa * fm <= 0:
                                b0, fb = mid, fm
                            else:
                                a0, fa = mid, fm
                        root_offset = 0.5 * (a0 + b0)

            lat_root, mecl_root, iso_root = moon_state(root_offset)
            lon_at_root = float(mecl_root.lon.to(u.deg).value % 360.0)

            try:
                eps = 1e-3
                lat_before, _, _ = moon_state(root_offset - eps)
                lat_after, _, _ = moon_state(root_offset + eps)
                ascending = (lat_after - lat_before) > 0
            except Exception:
                ascending = True

            if ascending:
                asc_node_lon = lon_at_root
                desc_node_lon = (asc_node_lon + 180.0) % 360.0
            else:
                desc_node_lon = lon_at_root
                asc_node_lon = (desc_node_lon + 180.0) % 360.0
            if return_info:
                return asc_node_lon, desc_node_lon, {
                    "root_offset_days": float(root_offset),
                    "iso_root": iso_root,
                    "ascending": bool(ascending),
                    "samples": len(state_cache),
                }
            return asc_node_lon, desc_node_lon
        except Exception:
            if return_info:
                return None, None, {"error": "exception"}
            return None, None

    def find_mc_lambda_by_ra(dt_utc_dt: datetime, lon_deg: float):
        t_ast_local = Time(dt_utc_dt)
        lst = float(t_ast_local.sidereal_time('apparent', longitude=lon_deg * u.deg).to(u.deg).value)

        def ra_minus_lst(lambda_deg: float) -> float:
            c = SkyCoord(lon=lambda_deg * u.deg, lat=0 * u.deg, frame=BarycentricTrueEcliptic(equinox='J2000'))
            icrs = c.transform_to('icrs')
            ra = float(icrs.ra.to(u.deg).value)
            return ((ra - lst + 180) % 360) - 180

        step = 1.0
        lons = np.arange(0.0, 360.0 + step, step)
        vals = [ra_minus_lst(L) for L in lons]
        intervals = []
        for i in range(len(lons) - 1):
            a, b = vals[i], vals[i + 1]
            if a == 0.0:
                intervals.append((lons[i], lons[i]))
            elif a * b < 0:
                intervals.append((lons[i], lons[i + 1]))

        roots = []
        for la, lb in intervals:
            try:
                if la == lb:
                    root = la
                else:
                    if brentq is not None:
                        root = brentq(lambda x: ra_minus_lst(x), la, lb, xtol=1e-6, maxiter=100)
                    else:
                        a0, b0 = la, lb
                        fa0, fb0 = ra_minus_lst(a0), ra_minus_lst(b0)
                        for _ in range(60):
                            m = 0.5 * (a0 + b0)
                            fm = ra_minus_lst(m)
                            if abs(fm) < 1e-6:
                                break
                            if fa0 * fm <= 0:
                                b0, fb0 = m, fm
                            else:
                                a0, fa0 = m, fm
                        root = 0.5 * (a0 + b0)
                roots.append(root % 360.0)
            except Exception:
                continue

        if roots:
            return float(sorted(roots, key=lambda x: abs(((ra_minus_lst(x) + 180) % 360) - 180))[0])
        return None

    def compute_porphyry_cusps(asc_lambda: float, mc_lambda: float):
        # Explicit Porphyry: divide each quadrant (Asc->MC, MC->Desc, Desc->IC, IC->Asc)
        def norm360(x):
            return float(x % 360.0)

        A = float(asc_lambda % 360.0)
        M = float(mc_lambda % 360.0)
        D = float((A + 180.0) % 360.0)
        IC = float((M + 180.0) % 360.0)

        def arc_len(a, b):
            return float((b - a) % 360.0)

        q1 = arc_len(A, M)
        q2 = arc_len(M, D)
        q3 = arc_len(D, IC)
        q4 = arc_len(IC, A)

        quadrant_lengths = [q1, q2, q3, q4]

        # Build unwrapped, strictly increasing cusps starting at A and spanning one full circle
        cusps_unwrapped = []
        cumul = A
        for q in quadrant_lengths:
            step = q / 3.0
            # three cusps in this quadrant: start, start+step, start+2*step
            for i in range(3):
                cusps_unwrapped.append(float(cumul))
                cumul = cumul + step

        # cumul should now equal A + 360 (within floating error). Ensure length 12
        return cusps_unwrapped[:12]

    def planet_house_position(planet_lambda: float, cusps: list):
        # cusps is expected to be an unwrapped, increasing list starting at Asc (may exceed 360)
        lam0 = float(planet_lambda % 360.0)
        # bring lam0 into the same unwrapped cycle as cusps[0]
        base = float(cusps[0])
        while lam0 < base:
            lam0 += 360.0
        while lam0 >= base + 360.0:
            lam0 -= 360.0

        # iterate through unwrapped cusps to find the interval
        for i in range(12):
            a = float(cusps[i])
            if i < 11:
                b = float(cusps[i + 1])
            else:
                b = float(cusps[0]) + 360.0
            if a <= lam0 < b:
                width = b - a
                dist = lam0 - a
                p = dist / width if width > 0 else 0.0
                return i + 1, p, width

        # fallback: return house 1 and width of first interval
        first_width = float((cusps[1] - cusps[0]) if len(cusps) > 1 else 30.0)
        return 1, 0.0, first_width

    def hann_strength(p: float) -> float:
        return 0.5 * (1.0 - np.cos(2.0 * np.pi * p))

    # compute full planet rows
    try:
        lambdas_map, eph = get_planet_lambdas_j2000(dt_utc.isoformat())
    except Exception:
        lambdas_map = {}
        eph = None

    nodes_error = None
    nodes_info = None
    nodes_method_used = 'eclipse_based'  # Always use eclipse-based calculation
    node_speed_samples = 0  # Always defined for output

    try:
        # Convert datetime to required format for calculate_nodes
        rahu_lon, ketu_lon = calculate_nodes(dt_utc)
    except Exception as e:
        if nodes_error is None:
            try:
                nodes_error = str(e)
            except Exception:
                nodes_error = repr(e)
        rahu_lon = ketu_lon = None

    if rahu_lon is not None:
        # Verify that `Rahu` corresponds to the ascending (north) node.
        # If nodes_info provides iso_root and ascending flag, use it; otherwise sample lat before/after root
        try:
            is_ascending_detected = None
            if nodes_info and isinstance(nodes_info, dict) and 'ascending' in nodes_info:
                is_ascending_detected = bool(nodes_info.get('ascending'))
            else:
                # attempt sampling at root time if available
                if nodes_info and isinstance(nodes_info, dict) and 'iso_root' in nodes_info:
                    try:
                        root_iso = nodes_info.get('iso_root')
                        t_root = Time(root_iso)
                        t_before = t_root - (60.0 * u.s)
                        t_after = t_root + (60.0 * u.s)
                        coords_before = planet_positions_icrs(t_before.iso, eph=eph) if eph is not None else planet_positions_icrs(t_before.iso)
                        coords_after = planet_positions_icrs(t_after.iso, eph=eph) if eph is not None else planet_positions_icrs(t_after.iso)
                        m_before = coords_before.get('Moon').transform_to(BarycentricTrueEcliptic(equinox='J2000'))
                        m_after = coords_after.get('Moon').transform_to(BarycentricTrueEcliptic(equinox='J2000'))
                        lat_before = float(m_before.lat.to(u.deg).value)
                        lat_after = float(m_after.lat.to(u.deg).value)
                        is_ascending_detected = (lat_after - lat_before) > 0
                    except Exception:
                        is_ascending_detected = None
            # if detection suggests the node we labeled as rahu is actually descending, swap
            # Note: do not add 180° here — the helper returns asc/desc already. We only need to swap the labels.
            if is_ascending_detected is not None and is_ascending_detected is False:
                rahu_lon, ketu_lon = ketu_lon, rahu_lon
        except Exception:
            # if any of the checks fail, keep original ordering
            pass

        # No need for orbital plane checks with eclipse data - already correct

        # allow overriding convention: request-level flag (True/False/None) -> env var -> default
        rahu_is_desc = False  # гарантируем определение переменной
        try:
            rahu_is_desc_req_raw = getattr(data, 'rahu_is_descending', None)
        except Exception:
            rahu_is_desc_req_raw = None
        rahu_is_desc_req = None if rahu_is_desc_req_raw is None else bool(rahu_is_desc_req_raw)
        try:
            rahu_is_desc_env = bool(int(os.environ.get('RAHU_IS_DESCENDING', '0')))
        except Exception:
            rahu_is_desc_env = False
        # Variant B: server default convention. Historically the project
        # used Rahu as the ascending (true) node; prefer that as the server
        # default to avoid surprising swaps. Request-level flag and env var
        # still override this behavior.
        if rahu_is_desc_req is not None:
            rahu_is_desc = rahu_is_desc_req
        elif rahu_is_desc_env:
            rahu_is_desc = rahu_is_desc_env
        else:
            # Default: Rahu = ascending (i.e. not descending)
            rahu_is_desc = False
        # Write into lambdas_map (used later to build planet rows). Keep raw longitudes —
        # we'll resolve constellations for nodes the same way as planets so they appear in the correct sign/IAU.
        if rahu_is_desc:
            lambdas_map['Rahu'] = ketu_lon
            lambdas_map['Ketu'] = rahu_lon
        else:
            lambdas_map['Rahu'] = rahu_lon
            lambdas_map['Ketu'] = ketu_lon
        # compute approximate node speeds (deg/day) using a robust multi-sample derivative
        node_speed_samples = 0
        try:
            node_ra_speed = 0.0
            node_ke_speed = 0.0

            samples: list[tuple[float, float, float]] = []
            base_time = Time(dt_utc)
            day_offsets = [-3.0, -2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0, 3.0]

            for offset in day_offsets:
                try:
                    t_sample = base_time + float(offset) * u.day
                    asc_lon = desc_lon = None
                    try:
                        asc_lon, desc_lon = compute_nodes_from_orbital_plane(eph, t_sample)
                    except Exception:
                        asc_lon = desc_lon = None
                    if asc_lon is None or desc_lon is None:
                        try:
                            res_sample = compute_nodes_from_moon_lat_via_positions(eph, t_sample, search_days=7.0)
                            if isinstance(res_sample, tuple):
                                if len(res_sample) == 3:
                                    asc_lon, desc_lon = res_sample[0], res_sample[1]
                                elif len(res_sample) >= 2:
                                    asc_lon, desc_lon = res_sample[0], res_sample[1]
                            else:
                                asc_lon = desc_lon = None
                        except Exception:
                            asc_lon = desc_lon = None
                    if asc_lon is None or desc_lon is None:
                        continue
                    samples.append((float(offset), float(asc_lon), float(desc_lon)))
                except Exception:
                    continue

            node_speed_samples = len(samples)

            def fit_rate(sample_list, value_index: int):
                if len(sample_list) < 2:
                    return None
                times = np.asarray([s[0] for s in sample_list], dtype=float)
                lons = np.asarray([s[value_index] for s in sample_list], dtype=float)
                phases = np.unwrap(np.deg2rad(lons))
                A = np.vstack([times, np.ones_like(times)]).T
                try:
                    slope_rad, _ = np.linalg.lstsq(A, phases, rcond=None)[0]
                except Exception:
                    return None
                return float(slope_rad * 180.0 / np.pi)

            asc_rate = fit_rate(samples, 1)
            desc_rate = fit_rate(samples, 2)

            chosen_rate = None
            if asc_rate is not None and desc_rate is not None:
                chosen_rate = float(0.5 * (asc_rate + desc_rate))
            elif asc_rate is not None:
                chosen_rate = float(asc_rate)
            elif desc_rate is not None:
                chosen_rate = float(desc_rate)

            if chosen_rate is not None:
                node_ra_speed = float(chosen_rate)
                node_ke_speed = float(chosen_rate)
            else:
                node_ra_speed = node_ke_speed = 0.0
        except Exception:
            node_ra_speed = node_ke_speed = 0.0
        # Variant A: canonical mean-node speed fallback when computed speeds are effectively zero
        try:
            CANONICAL_NODE_SPEED = -0.0529539
            SPEED_EPS = 1e-4
            if node_ra_speed is None or abs(node_ra_speed) < SPEED_EPS:
                node_ra_speed = CANONICAL_NODE_SPEED
            if node_ke_speed is None or abs(node_ke_speed) < SPEED_EPS:
                node_ke_speed = CANONICAL_NODE_SPEED
        except Exception:
            node_ra_speed = node_ke_speed = -0.0529539

    def resolve_constellation_from_lon(lambda_deg: float):
        code, name_ru = iau_for_lon_with_overrides(lambda_deg)
        return code or '', name_ru or ''

    mc_lambda = find_mc_lambda_by_ra(dt_utc, data.longitude)
    # Validate MC: it should be roughly 90° from Asc (Porphyry expects quadrants)
    if mc_lambda is None:
        mc_lambda = (asc.lon_sidereal + 90.0) % 360.0
    else:
        try:
            diff = abs(((float(mc_lambda) - float(asc.lon_sidereal) + 180.0) % 360.0) - 180.0)
            # if MC isn't near 90° (allow ±30°), fallback
            if abs(diff - 90.0) > 30.0:
                mc_lambda = (asc.lon_sidereal + 90.0) % 360.0
        except Exception:
            mc_lambda = (asc.lon_sidereal + 90.0) % 360.0

    porphyry_cusps = compute_porphyry_cusps(asc.lon_sidereal % 360.0, mc_lambda)
    debug_porphyry = [float(x) for x in porphyry_cusps]

    planet_rows = []
    mapping = {
        'Sun': 'Su', 'Moon': 'Mo', 'Mercury': 'Me', 'Venus': 'Ve', 'Mars': 'Ma', 'Jupiter': 'Ju', 'Saturn': 'Sa'
    }
    # For retrograde/speed calculation, compute planet lambdas at t and t+dt
    delta_hours = 1.0
    try:
        lambdas_map_dt, _ = get_planet_lambdas_j2000((Time(dt_utc) + delta_hours * u.hour).iso)
    except Exception:
        lambdas_map_dt = {}

    for body_name, abbr in mapping.items():
        lam = lambdas_map.get(body_name)
        if lam is None:
            continue
        try:
            iau_code, iau_name_ru = resolve_constellation_from_lon(lam)
        except Exception:
            iau_code, iau_name_ru = '', ''
        house_idx, p, width = planet_house_position(lam, porphyry_cusps)
        # Bell-shaped strength by arc center
        arc = next((a for a in IAU_ECLIPTIC_ARCS if (a.get('iau_code') == iau_code)), None)
        if arc:
            start = float(arc.get('lon_start_deg', 0.0)) % 360.0
            end = float(arc.get('lon_end_deg', 0.0)) % 360.0
            mid = ((start + ((end - start + 360) % 360) / 2) % 360.0)
            # distance from center, normalized
            arc_width = ((end - start + 360) % 360.0)
            dist = min(abs((lam - mid + 360) % 360.0), abs((mid - lam + 360) % 360.0))
            strength = max(0.0, 1.0 - 2.0 * dist / arc_width)
        else:
            strength = 0.0
        # compute speed in deg/day using difference over delta_hours
        lam_dt = lambdas_map_dt.get(body_name)
        if lam_dt is not None:
            # delta lambda careful with wrap
            dlam = ((lam_dt - lam + 180.0) % 360.0) - 180.0
            speed_deg_per_day = (dlam / delta_hours) * 24.0
        else:
            speed_deg_per_day = 0.0
        is_retro = speed_deg_per_day < 0
        # attach Russian name from cached map if available
        iau_name_ru = iau_name_ru or IAU_CODE_TO_RU.get(iau_code, '')
        planet_rows.append({
            'name': abbr,
            'lambdaDeg': float(lam),
            'iauConstellation': iau_code or '',
            'iauNameRu': iau_name_ru or '',
            'houseIndex': house_idx,
            'houseProgressP': float(p),
            'houseStrength': float(strength),
            'houseArcDeg': float(width),
            'degIntoHouse': float(p * width),
            'sidereal_speed': float(speed_deg_per_day),
            'is_retrograde': bool(is_retro),
        })

    if 'Rahu' in lambdas_map:
        for nm, abbr in [('Rahu','Ra'), ('Ketu','Ke')]:
            lam = lambdas_map.get(nm)
            house_idx, p, width = planet_house_position(lam, porphyry_cusps)
            strength = hann_strength(p)
            # compute node speed from earlier computed node_ra_speed / node_ke_speed
            if nm == 'Rahu':
                nspeed = float(node_ra_speed if 'node_ra_speed' in locals() else 0.0)
            else:
                nspeed = float(node_ke_speed if 'node_ke_speed' in locals() else 0.0)
            nis_retro = nspeed < 0
            # Resolve IAU constellation and Russian name for nodes as we do for planets
            try:
                iau_code_node, iau_name_node = resolve_constellation_from_lon(lam)
            except Exception:
                iau_code_node, iau_name_node = '', ''
            planet_rows.append({
                'name': abbr,
                'lambdaDeg': float(lam),
                'iauConstellation': iau_code_node or '',
                'iauNameRu': iau_name_node or '',
                'houseIndex': house_idx,
                'houseProgressP': float(p),
                'houseStrength': float(strength),
                'houseArcDeg': float(width),
                'degIntoHouse': float(p * width),
                'sidereal_speed': nspeed,
                'is_retrograde': bool(nis_retro),
            })

    # No ad-hoc overrides here — use computed IAU arcs and Porphyry cusps

    # attach to debug_info later (debug_info defined after planets/houses)
    # --- End J2000 pipeline helpers ---

    # NOTE: planets will be created after houses are computed below so we can
    # assign houses based on the IAU->sign mapping (user requested behaviour).

    # Set MC from the computed J2000 mc_lambda when available (do not use ayanamsha for constellational mode)
    if mc_lambda is not None:
        # Determine MC sign via IAU arcs mapping to avoid raw lon/30 usage
        try:
            mc_iau_code, mc_iau_name = iau_for_lon_with_overrides(mc_lambda)
            mc_mapped_sign = IAU_TO_SIGN.get(mc_iau_code, SIGNS[0])
            mc_sign_idx = SIGNS.index(mc_mapped_sign) if mc_mapped_sign in SIGNS else 0
        except Exception:
            mc_sign_idx = 0
        mc = AscendantMC(sign=SIGNS[mc_sign_idx], degree=mc_lambda % 30, lon_sidereal=mc_lambda)
    else:
        mc = None

    # mark that we used constellational planets
    used_constellational_planets = True

    # Planets are produced above from J2000 pipeline and placed into `planets`.

    dt_iso_utc = dt_utc.isoformat()
    # Keep the external classifier output in debug, but DO NOT overwrite the planet IAU
    # codes we've already determined from `IAU_ECLIPTIC_ARCS` (loaded above). Overwriting
    # with `classify_planets` may reintroduce undesired constellations (e.g. Oph).
    # We still call the classifier to include its data in debug output, but we won't use
    # it to change the planets produced by the J2000 pipeline.
    planet_constellations = classify_planets(dt_iso_utc)
    arcs = IAU_ECLIPTIC_ARCS

    # Use high-fidelity classifier output (full RA/Dec polygons) to override the
    # simple ecliptic-arc based constellation labels for each planet. This makes
    # sure bodies that sit off the ecliptic near a tilted boundary (e.g. Jupiter
    # between Aquarius/Pisces) are assigned exactly as in Stellarium/IAU.
    body_to_abbr = {
        "Sun": "Su",
        "Moon": "Mo",
        "Mercury": "Me",
        "Venus": "Ve",
        "Mars": "Ma",
        "Jupiter": "Ju",
        "Saturn": "Sa",
        "Uranus": "Ur",
        "Neptune": "Ne",
    }
    iau_override_map: dict[str, tuple[str, str]] = {}

    def _get_attr(obj, key, default=None):
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    for entry in planet_constellations:
        body_name = _get_attr(entry, "body")
        if not body_name:
            continue
        abbr = body_to_abbr.get(str(body_name))
        if not abbr:
            continue
        iau_code = _get_attr(entry, "iau_code") or ""
        iau_name_ru = _get_attr(entry, "iau_name_ru") or IAU_CODE_TO_RU.get(iau_code, "")
        if iau_code:
            iau_override_map[abbr] = (str(iau_code), str(iau_name_ru))

    # Apply overrides to the intermediate planet rows before houses/signs are resolved
    if iau_override_map:
        for row in planet_rows:
            name = row.get("name")
            override = iau_override_map.get(name)
            if not override:
                continue
            code, name_ru = override
            if code:
                row["iauConstellation"] = code
            if name_ru:
                row["iauNameRu"] = name_ru or IAU_CODE_TO_RU.get(code, row.get("iauNameRu", ""))

    # Planetary aspects (Vedic drishti) - will compute after planets list is built
    aspects_raw = []
    house_aspects_map = {i: [] for i in range(1, 13)}

    # Houses
    # Ensure mc is set (fallback: ASC + 90° already applied earlier)
    if mc is None:
        mc_lambda = (asc.lon_sidereal + 90.0) % 360.0
        mc_sign_idx = int(mc_lambda / 30) % 12
        mc = AscendantMC(sign=SIGNS[mc_sign_idx], degree=mc_lambda % 30, lon_sidereal=mc_lambda)

    # determine starting sign index for houses using mapped asc.sign
    if asc.sign in SIGNS:
        asc_sign_idx = SIGNS.index(asc.sign)
    else:
        asc_sign_idx = 0
    houses = [House(house=i+1, sign=SIGNS[(asc_sign_idx + i) % 12]) for i in range(12)]

    # Build Planet models now that `houses` (and their signs) are known.
    planets = []
    for row in planet_rows:
        lam = float(row.get('lambdaDeg') % 360.0)
        iau_code = (row.get('iauConstellation') or '')
        # Map IAU constellation code to zodiac sign using IAU_TO_SIGN
        sign_from_iau = IAU_TO_SIGN.get(iau_code)
        # If mapping wasn't available, fallback to previously computed houseIndex -> sign
        provided_house = int(row.get('houseIndex', 1)) if row.get('houseIndex') is not None else 1
        if sign_from_iau:
            # find house whose sign matches sign_from_iau
            house_idx = next((h.house for h in houses if h.sign == sign_from_iau), None)
            if house_idx is None:
                # fallback to provided houseIndex
                house_idx = provided_house
            sign = sign_from_iau
        else:
            # fallback: derive sign from Asc + house offset (compatibility)
            try:
                asc_sign_idx_local = SIGNS.index(asc.sign) if asc.sign in SIGNS else 0
            except Exception:
                asc_sign_idx_local = 0
            sign = SIGNS[(asc_sign_idx_local + (provided_house - 1)) % 12]
            house_idx = provided_house
        is_retro = bool(row.get('is_retrograde', False))
        speed = float(row.get('sidereal_speed', 0.0))
        house_progress = float(row.get('houseProgressP', 0.0))
        house_strength = float(row.get('houseStrength', 0.0))
        planets.append(Planet(
            name=row.get('name'),
            lon_sidereal=float(lam),
            sign=sign,
            house=house_idx,
            nakshatra=None,
            iau_constellation=iau_code or '',
            is_retrograde=is_retro,
            sidereal_speed=speed,
            house_progress=house_progress,
            house_strength=house_strength
        ))

    # Planetary aspects (Vedic drishti)
    aspects_raw = []
    house_aspects_map = {i: [] for i in range(1, 13)}
    for planet in planets:
        offsets = VEDIC_ASPECT_OFFSETS.get(planet.name, [6])
        for offset in offsets:
            target_house = ((planet.house - 1 + offset) % 12) + 1
            houses_away = offset + 1
            aspect_entry = {
                "planet": planet.name,
                "from_house": planet.house,
                "to_house": target_house,
                "houses_away": houses_away,
                "label": planet.name,
            }
            aspects_raw.append(aspect_entry)
            house_aspects_map[target_house].append(aspect_entry)

    # North-Indian layout
    layout = north_indian_layout([h.sign for h in houses], [p.model_dump() for p in planets], house_aspects_map)
    north_layout = NorthIndianLayout(boxes=[
        NorthIndianBox(
            sign=box["sign"],
            house=box["house"],
            bodies=box["bodies"],
            aspects=[AspectLabel(**aspect) for aspect in box.get("aspects", [])],
        ) for box in layout["boxes"]
    ])

    debug_info = {
        "payload": data.model_dump(),
        "datetime_iso": data.datetime_iso,
        "datetime_utc": dt_utc.isoformat(),
        "latitude": data.latitude,
        "longitude": data.longitude,
        "jd": jd,
        "aspects": aspects_raw,
        "constellation_arcs": arcs,
        "planet_constellations": planet_constellations,
        "porphyry_cusps": debug_porphyry,
        "nodes_computed": (rahu_lon is not None),
        "nodes": {
            "Rahu": (rahu_lon if 'rahu_lon' in locals() else None),
            "Ketu": (ketu_lon if 'ketu_lon' in locals() else None),
        },
        "nodes_info": nodes_info,
        "nodes_method_used": nodes_method_used,
        "node_speed_samples": node_speed_samples,
        "nodes_error": nodes_error,
        "lambdas_map_keys": list(lambdas_map.keys()) if isinstance(lambdas_map, dict) else [],
        "tz_detect": {
            "used_iana_tz": bool(used_iana_tz),
            "used_iana_name": used_iana_name,
            "used_approx_tz": bool(used_approx_tz),
            "used_approx_offset_min": used_approx_offset,
        },
        "nodes_method_used": nodes_method_used,
        "nodes_info": nodes_info,
    "rahu_is_desc_used": rahu_is_desc,
        "asc_lon_sidereal": float(asc.lon_sidereal),
        "asc_iau_code": asc_iau_code,
        "asc_iau_name_ru": asc_iau_name_ru,
    "asc_mapped_sign": asc_mapped_sign,
        "mc_lambda": float(mc.lon_sidereal) if mc is not None else None,
    }
    # if constellational pipeline produced planet_rows, attach them
    try:
        debug_info['constellational_planet_rows'] = planet_rows  # type: ignore[name-defined]
    except Exception:
        pass
    return ChartResponse(
        ascendant=asc,
        mc=mc,
        planets=planets,
        houses=houses,
        north_indian_layout=north_layout,
        aspects=[AspectLabel(**aspect) for aspect in aspects_raw],
        constellation_arcs=[ConstellationArc(**arc) for arc in arcs],
        planet_constellations=[PlanetConstellation(**row) for row in planet_constellations],
        debug_info=debug_info,
    )
