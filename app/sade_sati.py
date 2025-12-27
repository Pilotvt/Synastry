from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional, Tuple

import astropy.units as u
from astropy.coordinates import BarycentricTrueEcliptic, SkyCoord
from skyfield.api import load as skyfield_load
from skyfield.errors import EphemerisRangeError
from iau_constellations.planets.ephemeris import load_ephemeris

from .resource_paths import RESOURCE_ROOT, ephemeris_path
from .schemas import SadeSatiPeriod, SadeSatiRequest, SadeSatiResponse, SadeSatiSegment

_EPH = None
_TS = None
_EARTH = None
_SATURN = None

_EPHEMERIS_RANGE_UTC: tuple[datetime, datetime] | None = None


def _parse_datetime_iso(value: str) -> datetime:
    raw = (value or "").strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _wrap180(deg: float) -> float:
    return ((float(deg) + 180.0) % 360.0) - 180.0


def _normalize360(deg: float) -> float:
    return float(deg) % 360.0


def _get_eph():
    global _EPH
    if _EPH is None:
        _EPH = load_ephemeris(str(RESOURCE_ROOT))
    return _EPH


def _get_ephemeris_valid_range_utc() -> tuple[datetime, datetime]:
    global _EPHEMERIS_RANGE_UTC
    if _EPHEMERIS_RANGE_UTC is not None:
        return _EPHEMERIS_RANGE_UTC

    path = ephemeris_path()
    start = datetime(1900, 1, 1, tzinfo=timezone.utc)
    end = datetime(2050, 1, 1, tzinfo=timezone.utc)

    try:
        from jplephem.spk import SPK  # type: ignore

        spk = SPK.open(str(path))
        try:
            segments = list(getattr(spk, "segments", []) or [])
            if segments:
                start_jd = min(float(seg.start_jd) for seg in segments)
                end_jd = max(float(seg.end_jd) for seg in segments)

                ts = skyfield_load.timescale()
                start = ts.tdb(jd=start_jd).utc_datetime().astimezone(timezone.utc)
                end = ts.tdb(jd=end_jd).utc_datetime().astimezone(timezone.utc)
        finally:
            try:
                spk.close()
            except Exception:
                pass
    except Exception:
        # Keep conservative defaults on failure.
        pass

    _EPHEMERIS_RANGE_UTC = (start, end)
    return _EPHEMERIS_RANGE_UTC


def _saturn_lon_j2000(dt_utc: datetime) -> float:
    global _TS, _EARTH, _SATURN
    eph = _get_eph()
    if _TS is None:
        _TS = skyfield_load.timescale()
    if _EARTH is None:
        _EARTH = eph["earth"]
    if _SATURN is None:
        _SATURN = eph["saturn barycenter"]

    dt = dt_utc.astimezone(timezone.utc)
    try:
        t = _TS.utc(
            dt.year,
            dt.month,
            dt.day,
            dt.hour,
            dt.minute,
            dt.second + dt.microsecond / 1_000_000.0,
        )
        astrometric = _EARTH.at(t).observe(_SATURN).apparent()
    except EphemerisRangeError:
        raise
    except Exception as exc:
        raise RuntimeError("Failed to compute Saturn position") from exc

    ra, dec, _distance = astrometric.radec()
    saturn_icrs = SkyCoord(ra=ra.to(u.deg), dec=dec.to(u.deg))
    ecl = saturn_icrs.transform_to(BarycentricTrueEcliptic(equinox="J2000"))
    return float(ecl.lon.to(u.deg).value % 360.0)


def _window_metric(sat_lon: float, moon_lon: float, half_width_deg: float) -> float:
    delta = _wrap180(sat_lon - moon_lon)
    return abs(delta) - float(half_width_deg)


def _refine_crossing_utc(
    t0: datetime,
    t1: datetime,
    moon_lon: float,
    half_width_deg: float,
    sat_lon_at: Callable[[datetime], float],
    tol_seconds: float = 60.0,
    max_iter: int = 64,
) -> datetime:
    if t1 < t0:
        t0, t1 = t1, t0

    f0 = _window_metric(sat_lon_at(t0), moon_lon, half_width_deg)
    if abs(f0) < 1e-10:
        return t0
    f1 = _window_metric(sat_lon_at(t1), moon_lon, half_width_deg)
    if abs(f1) < 1e-10:
        return t1

    # We expect a sign change (outside->inside or inside->outside).
    if f0 * f1 > 0:
        return t0 + (t1 - t0) / 2

    a, b = t0, t1
    fa, fb = f0, f1
    for _ in range(max_iter):
        if (b - a).total_seconds() <= tol_seconds:
            break
        m = a + (b - a) / 2
        fm = _window_metric(sat_lon_at(m), moon_lon, half_width_deg)
        if abs(fm) < 1e-10:
            a = b = m
            break
        if fa * fm <= 0:
            b, fb = m, fm
        else:
            a, fa = m, fm
    return a + (b - a) / 2


def compute_sade_sati(payload: SadeSatiRequest) -> SadeSatiResponse:
    moon_lon = float(payload.moon_lon_deg)
    half_width_deg = float(payload.half_width_deg or 45.0)

    ref_utc = _parse_datetime_iso(payload.reference_datetime_iso)
    scan_start = ref_utc - timedelta(days=float(payload.years_back) * 365.2425)
    scan_end = ref_utc + timedelta(days=float(payload.years_forward) * 365.2425)
    step_days = max(0.25, float(payload.step_days))
    merge_gap_days = max(0.0, float(payload.merge_gap_days))

    # Clamp scan window to ephemeris validity range to avoid 500 errors.
    ephe_start, ephe_end = _get_ephemeris_valid_range_utc()
    scan_start = max(scan_start, ephe_start)
    scan_end = min(scan_end, ephe_end)
    if scan_end <= scan_start:
        start_boundary_lon = _normalize360(moon_lon - half_width_deg)
        end_boundary_lon = _normalize360(moon_lon + half_width_deg)
        return SadeSatiResponse(
            moon_lon_deg=_normalize360(moon_lon),
            half_width_deg=half_width_deg,
            start_boundary_lon_deg=start_boundary_lon,
            end_boundary_lon_deg=end_boundary_lon,
            reference_utc=ref_utc,
            periods=[],
            selected_index=0,
            inside_selected=False,
        )

    lon_cache: Dict[int, float] = {}

    def sat_lon_at(dt_utc: datetime) -> float:
        key = int(dt_utc.replace(tzinfo=timezone.utc).timestamp())
        cached = lon_cache.get(key)
        if cached is not None:
            return cached
        lon = _saturn_lon_j2000(dt_utc)
        lon_cache[key] = lon
        return lon

    def inside_at(dt_utc: datetime) -> bool:
        return _window_metric(sat_lon_at(dt_utc), moon_lon, half_width_deg) <= 0.0

    # Coarse scan to find inside/outside transitions.
    segments_raw: List[Tuple[datetime, datetime]] = []
    t_prev = scan_start
    inside_prev = inside_at(t_prev)
    seg_start: Optional[datetime] = t_prev if inside_prev else None

    step = timedelta(days=step_days)
    t = scan_start
    while t < scan_end:
        t_next = min(scan_end, t + step)
        inside_next = inside_at(t_next)
        if (not inside_prev) and inside_next:
            seg_start = _refine_crossing_utc(t, t_next, moon_lon, half_width_deg, sat_lon_at)
        elif inside_prev and (not inside_next) and seg_start is not None:
            seg_end = _refine_crossing_utc(t, t_next, moon_lon, half_width_deg, sat_lon_at)
            segments_raw.append((seg_start, seg_end))
            seg_start = None
        t, inside_prev = t_next, inside_next

    if inside_prev and seg_start is not None:
        segments_raw.append((seg_start, scan_end))

    segments_raw.sort(key=lambda x: x[0])

    # Merge nearby segments (retrograde "out/in" around the boundary) into periods.
    periods: List[SadeSatiPeriod] = []
    if segments_raw:
        current_start, current_end = segments_raw[0]
        current_segments = [SadeSatiSegment(start_utc=current_start, end_utc=current_end)]
        merge_gap = timedelta(days=merge_gap_days)

        for s, e in segments_raw[1:]:
            if s <= current_end + merge_gap:
                current_segments.append(SadeSatiSegment(start_utc=s, end_utc=e))
                if e > current_end:
                    current_end = e
            else:
                duration_days = (current_end - current_start).total_seconds() / 86400.0
                periods.append(
                    SadeSatiPeriod(
                        start_utc=current_start,
                        end_utc=current_end,
                        duration_days=duration_days,
                        segments=current_segments,
                    )
                )
                current_start, current_end = s, e
                current_segments = [SadeSatiSegment(start_utc=s, end_utc=e)]

        duration_days = (current_end - current_start).total_seconds() / 86400.0
        periods.append(
            SadeSatiPeriod(
                start_utc=current_start,
                end_utc=current_end,
                duration_days=duration_days,
                segments=current_segments,
            )
        )

    # Choose which period to highlight relative to reference.
    selected_index = 0
    inside_selected = False
    if periods:
        selected_index = None
        for i, p in enumerate(periods):
            if p.start_utc <= ref_utc <= p.end_utc:
                selected_index = i
                inside_selected = True
                break
        if selected_index is None:
            for i, p in enumerate(periods):
                if p.start_utc > ref_utc:
                    selected_index = i
                    break
        if selected_index is None:
            selected_index = len(periods) - 1
        selected_index = int(selected_index)

    start_boundary_lon = _normalize360(moon_lon - half_width_deg)
    end_boundary_lon = _normalize360(moon_lon + half_width_deg)

    return SadeSatiResponse(
        moon_lon_deg=_normalize360(moon_lon),
        half_width_deg=half_width_deg,
        start_boundary_lon_deg=start_boundary_lon,
        end_boundary_lon_deg=end_boundary_lon,
        reference_utc=ref_utc,
        periods=periods,
        selected_index=selected_index,
        inside_selected=inside_selected,
    )
