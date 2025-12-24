from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import cos, floor, radians

from skyfield.api import Loader, load as skyfield_load

from .resource_paths import get_resource_root, resource_path

_RESOURCE_ROOT_STR = str(get_resource_root())
_DE421_PATH = resource_path("de421.bsp")

_loader = Loader(_RESOURCE_ROOT_STR)
_eph = _loader(str(_DE421_PATH))
_ts = skyfield_load.timescale()

_earth = _eph["earth"]
_sun = _eph["sun"]
_moon = _eph["moon"]


def _parse_datetime_iso(value: str) -> datetime:
    raw = (value or "").strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _moon_sun_elongation_deg(dt_utc: datetime) -> float:
    dt_utc = dt_utc.astimezone(timezone.utc)
    t = _ts.utc(
        dt_utc.year,
        dt_utc.month,
        dt_utc.day,
        dt_utc.hour,
        dt_utc.minute,
        dt_utc.second + dt_utc.microsecond / 1_000_000.0,
    )
    earth_at = _earth.at(t)
    sun_lon = earth_at.observe(_sun).apparent().ecliptic_latlon()[1].degrees % 360.0
    moon_lon = earth_at.observe(_moon).apparent().ecliptic_latlon()[1].degrees % 360.0
    return (moon_lon - sun_lon) % 360.0


def _unwrap_to_reference(raw_deg: float, ref_deg: float) -> float:
    value = raw_deg
    while value - ref_deg > 180.0:
        value -= 360.0
    while value - ref_deg < -180.0:
        value += 360.0
    return value


def _find_boundary(dt_utc: datetime, target_raw_deg: float, direction: int) -> datetime:
    """Find time when elongation crosses target (mod 360), near dt_utc.

    direction:
      +1 -> search forward for next crossing
      -1 -> search backward for previous crossing
    """

    if direction not in (-1, 1):
        raise ValueError("direction must be -1 or +1")

    start = dt_utc.astimezone(timezone.utc)
    ref_raw = _moon_sun_elongation_deg(start)
    ref = ref_raw
    target_raw = target_raw_deg % 360.0
    target = _unwrap_to_reference(target_raw, ref)

    if direction > 0:
        if target <= ref + 1e-9:
            target += 360.0
    else:
        if target >= ref - 1e-9:
            target -= 360.0

    step = timedelta(minutes=20)
    max_steps = int((timedelta(days=3) / step) + 1)

    def advance_time(t: datetime, d: int) -> datetime:
        return t + (step if d > 0 else -step)

    prev_t = start
    prev_val = ref

    low_t: datetime | None = None
    high_t: datetime | None = None
    low_val: float | None = None
    high_val: float | None = None

    for _ in range(max_steps):
        next_t = advance_time(prev_t, direction)
        next_raw = _moon_sun_elongation_deg(next_t)
        next_val = _unwrap_to_reference(next_raw, prev_val)

        if direction > 0:
            if prev_val <= target <= next_val:
                low_t, high_t = prev_t, next_t
                low_val, high_val = prev_val, next_val
                break
        else:
            if next_val <= target <= prev_val:
                low_t, high_t = next_t, prev_t
                low_val, high_val = next_val, prev_val
                break

        prev_t, prev_val = next_t, next_val

    if low_t is None or high_t is None or low_val is None or high_val is None:
        raise RuntimeError("Failed to bracket tithi boundary")

    # Bisection to ~1 second.
    for _ in range(70):
        span_s = (high_t - low_t).total_seconds()
        if span_s <= 1.0:
            break
        mid_t = low_t + timedelta(seconds=span_s / 2.0)
        mid_raw = _moon_sun_elongation_deg(mid_t)
        mid_val = _unwrap_to_reference(mid_raw, (low_val + high_val) / 2.0)

        if mid_val < target:
            low_t, low_val = mid_t, mid_val
        else:
            high_t, high_val = mid_t, mid_val

    return high_t


@dataclass(frozen=True)
class TithiInfo:
    tithi: int
    paksha: str
    start_utc: datetime
    end_utc: datetime
    phase_angle_deg: float
    illumination: float


def compute_tithi(datetime_iso: str) -> TithiInfo:
    dt_utc = _parse_datetime_iso(datetime_iso)
    phase_angle_deg = _moon_sun_elongation_deg(dt_utc)
    tithi = int(floor(phase_angle_deg / 12.0)) + 1
    if tithi < 1:
        tithi = 1
    if tithi > 30:
        tithi = 30

    paksha = "shukla" if tithi <= 15 else "krishna"

    lower = (tithi - 1) * 12.0
    upper = tithi * 12.0
    # represent 360° as 0° (next wrap) for searching
    upper_target = 0.0 if abs(upper - 360.0) < 1e-9 else upper

    start_utc = _find_boundary(dt_utc, lower, direction=-1)
    end_utc = _find_boundary(dt_utc, upper_target, direction=+1)

    # Convert elongation to illumination fraction (0=new, 1=full).
    beta = radians(phase_angle_deg)
    illumination = float((1.0 - cos(beta)) / 2.0)
    if illumination < 0.0:
        illumination = 0.0
    if illumination > 1.0:
        illumination = 1.0

    return TithiInfo(
        tithi=tithi,
        paksha=paksha,
        start_utc=start_utc,
        end_utc=end_utc,
        phase_angle_deg=float(phase_angle_deg),
        illumination=illumination,
    )

