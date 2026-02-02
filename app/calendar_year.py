from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from math import floor
from typing import Iterable, Literal

import pytz
from skyfield import almanac
from skyfield.framelib import ecliptic_J2000_frame

from .jyotish import IAU_ECLIPTIC_ARCS
from .tithi import _earth, _eph, _moon, _moon_sun_elongation_deg, _sun, _ts

CalendarEventKind = Literal["tithi", "sankranti", "eclipse", "window"]


IAU_TO_SIGN = {
    "Ari": "Ar",
    "Tau": "Ta",
    "Gem": "Ge",
    "Cnc": "Cn",
    "Leo": "Le",
    "Vir": "Vi",
    "Lib": "Li",
    "Sco": "Sc",
    "Oph": "Sc",
    "Sgr": "Sg",
    "Cap": "Cp",
    "Aqr": "Aq",
    "Psc": "Pi",
}


def _iau_code_for_lon_j2000(lon_deg: float) -> str:
    lam = float(lon_deg % 360.0)
    for arc in IAU_ECLIPTIC_ARCS:
        start = float(arc.get("lon_start_deg", 0.0)) % 360.0
        end = float(arc.get("lon_end_deg", 0.0)) % 360.0
        if start <= end:
            inside = start <= lam < end
        else:
            inside = lam >= start or lam < end
        if inside:
            return str(arc.get("iau_code") or "")
    return ""


def _sun_lon_j2000_deg(dt_utc: datetime) -> float:
    dt_utc = dt_utc.astimezone(timezone.utc)
    t = _ts.from_datetime(dt_utc)
    earth_at = _earth.at(t)
    _, lon, _ = earth_at.observe(_sun).apparent().frame_latlon(ecliptic_J2000_frame)
    return float(lon.degrees % 360.0)


def _sun_sign_code(dt_utc: datetime) -> str:
    lon = _sun_lon_j2000_deg(dt_utc)
    iau_code = _iau_code_for_lon_j2000(lon)
    return IAU_TO_SIGN.get(iau_code, "Ar")


def _unwrap_to_reference(raw_deg: float, ref_deg: float) -> float:
    value = raw_deg
    while value - ref_deg > 180.0:
        value -= 360.0
    while value - ref_deg < -180.0:
        value += 360.0
    return value


def _find_elongation_boundary(dt_utc: datetime, target_raw_deg: float, direction: int) -> datetime:
    """Fast boundary search for Moon-Sun elongation (mod 360) crossings."""

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

    step = timedelta(minutes=180)
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
        raise RuntimeError("Failed to bracket elongation boundary")

    for _ in range(40):
        span_s = (high_t - low_t).total_seconds()
        if span_s <= 60.0:
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
class _TithiInterval:
    tithi: int
    paksha: str
    start_utc: datetime
    end_utc: datetime


def _iter_tithi_intervals(window_start_utc: datetime, window_end_utc: datetime) -> Iterable[_TithiInterval]:
    dt_probe = window_start_utc - timedelta(days=2)
    dt_probe = dt_probe.astimezone(timezone.utc)

    phase = _moon_sun_elongation_deg(dt_probe)
    tithi = int(floor(phase / 12.0)) + 1
    tithi = max(1, min(30, tithi))
    paksha = "shukla" if tithi <= 15 else "krishna"

    lower = (tithi - 1) * 12.0
    upper = tithi * 12.0
    upper_target = 0.0 if abs(upper - 360.0) < 1e-9 else upper

    start_utc = _find_elongation_boundary(dt_probe, lower, direction=-1)
    end_utc = _find_elongation_boundary(dt_probe, upper_target, direction=+1)

    while start_utc < window_end_utc + timedelta(days=2):
        yield _TithiInterval(tithi=tithi, paksha=paksha, start_utc=start_utc, end_utc=end_utc)

        start_utc = end_utc
        tithi = 1 if tithi == 30 else (tithi + 1)
        paksha = "shukla" if tithi <= 15 else "krishna"

        upper = tithi * 12.0
        upper_target = 0.0 if abs(upper - 360.0) < 1e-9 else upper

        end_utc = _find_elongation_boundary(start_utc + timedelta(minutes=5), upper_target, direction=+1)


def _moon_ecliptic_lat_deg(dt_utc: datetime) -> float:
    dt_utc = dt_utc.astimezone(timezone.utc)
    t = _ts.from_datetime(dt_utc)
    earth_at = _earth.at(t)
    lat, _, _ = earth_at.observe(_moon).apparent().ecliptic_latlon()
    return float(lat.degrees)


def _compute_eclipse_moments_utc(year: int) -> list[tuple[datetime, str]]:
    t0 = _ts.utc(year, 1, 1)
    t1 = _ts.utc(year + 1, 1, 1)
    f = almanac.moon_phases(_eph)
    times, phases = almanac.find_discrete(t0, t1, f)

    out: list[tuple[datetime, str]] = []
    for t, phase in zip(times, phases):
        if int(phase) not in (0, 2):  # new/full only
            continue
        dt = t.utc_datetime().replace(tzinfo=timezone.utc)
        lat = abs(_moon_ecliptic_lat_deg(dt))
        if int(phase) == 0 and lat <= 1.5:
            out.append((dt, "solar"))
        elif int(phase) == 2 and lat <= 1.5:
            out.append((dt, "lunar"))
    return out


def _iter_sankranti_ingresses(year: int) -> list[tuple[datetime, str, str]]:
    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    step = timedelta(days=1)
    t0 = start
    sign0 = _sun_sign_code(t0)

    out: list[tuple[datetime, str, str]] = []

    while t0 < end:
        t1 = min(end, t0 + step)
        sign1 = _sun_sign_code(t1)
        if sign1 != sign0:
            low = t0
            high = t1
            for _ in range(40):
                span_s = (high - low).total_seconds()
                if span_s <= 60.0:
                    break
                mid = low + timedelta(seconds=span_s / 2.0)
                if _sun_sign_code(mid) == sign0:
                    low = mid
                else:
                    high = mid
            ingress = high
            new_sign = _sun_sign_code(ingress)
            out.append((ingress, sign0, new_sign))
            sign0 = new_sign
            t0 = ingress
        else:
            t0 = t1

    return out


@lru_cache(maxsize=32)
def compute_calendar_year(year: int, iana_tz: str) -> dict:
    if year < 1850 or year > 2149:
        raise ValueError("Год вне диапазона эфемерид DE440s (1850–2149).")

    tz = pytz.timezone(iana_tz)
    year_start = datetime(year, 1, 1, tzinfo=timezone.utc)
    year_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    events: list[dict] = []

    # --- Tithi-based events ---
    waxing_start: datetime | None = None
    for interval in _iter_tithi_intervals(year_start, year_end):
        overlaps = interval.end_utc > year_start and interval.start_utc < year_end
        if not overlaps:
            continue

        # Chaturthi / Navami / Chaturdashi (repeat after 15th)
        if interval.tithi in (4, 19):
            events.append(
                dict(
                    kind="tithi",
                    summary="Чатуртхи (не начинать дела)",
                    start_utc=interval.start_utc,
                    end_utc=interval.end_utc,
                    is_all_day=False,
                    meta={"tithi": interval.tithi, "paksha": interval.paksha},
                )
            )
        elif interval.tithi in (9, 24):
            events.append(
                dict(
                    kind="tithi",
                    summary="Навами (не начинать дела)",
                    start_utc=interval.start_utc,
                    end_utc=interval.end_utc,
                    is_all_day=False,
                    meta={"tithi": interval.tithi, "paksha": interval.paksha},
                )
            )
        elif interval.tithi in (14, 29):
            events.append(
                dict(
                    kind="tithi",
                    summary="Чатурдаши (не начинать дела)",
                    start_utc=interval.start_utc,
                    end_utc=interval.end_utc,
                    is_all_day=False,
                    meta={"tithi": interval.tithi, "paksha": interval.paksha},
                )
            )

        # Waxing / waning windows
        if interval.tithi == 1:
            waxing_start = interval.start_utc
        if interval.tithi == 15:
            waxing_end = interval.end_utc
            if waxing_start is not None:
                events.append(
                    dict(
                        kind="window",
                        summary="Растущая Луна с 1е по 15е Лунные сутки",
                        start_utc=waxing_start,
                        end_utc=waxing_end,
                        is_all_day=False,
                        meta={"paksha": "shukla"},
                    )
                )
            waxing_start = None

    # --- Sankranti windows (±6h) ---
    for ingress_utc, old_sign, new_sign in _iter_sankranti_ingresses(year):
        win_start = ingress_utc - timedelta(hours=6)
        win_end = ingress_utc + timedelta(hours=6)
        if win_end <= year_start or win_start >= year_end:
            continue
        events.append(
            dict(
                kind="sankranti",
                summary="6ч. до Сурья Сакранти 6ч. после",
                start_utc=win_start,
                end_utc=win_end,
                is_all_day=False,
                meta={"ingress_utc": ingress_utc, "from_sign": old_sign, "to_sign": new_sign},
            )
        )

    # --- Eclipse windows: 5 days before and after (all-day, local dates) ---
    for eclipse_utc, etype in _compute_eclipse_moments_utc(year):
        start_date_local = eclipse_utc.astimezone(tz).date() - timedelta(days=5)
        end_date_local_excl = eclipse_utc.astimezone(tz).date() + timedelta(days=6)

        start_local = tz.localize(datetime(start_date_local.year, start_date_local.month, start_date_local.day, 0, 0, 0))
        end_local = tz.localize(datetime(end_date_local_excl.year, end_date_local_excl.month, end_date_local_excl.day, 0, 0, 0))
        start_utc = start_local.astimezone(timezone.utc)
        end_utc = end_local.astimezone(timezone.utc)

        summary = "5д до Солнечного затмения и 5д после" if etype == "solar" else "5д до Лунного затмения и 5д после"
        events.append(
            dict(
                kind="eclipse",
                summary=summary,
                start_utc=start_utc,
                end_utc=end_utc,
                is_all_day=True,
                start_date=str(start_date_local),
                end_date=str(end_date_local_excl),
                meta={"eclipse_utc": eclipse_utc, "type": etype},
            )
        )

    events.sort(key=lambda e: (e["start_utc"], e["end_utc"], e["summary"]))
    return {"year": year, "iana_tz": iana_tz, "events": events}
