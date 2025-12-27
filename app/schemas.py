from pydantic import BaseModel, Field
from typing import Dict, List, Literal, Optional
from datetime import datetime

class ChartRequest(BaseModel):
    datetime_iso: str
    latitude: float
    longitude: float
    elevation_m: float = 0
    # If true, treat the node convention so that the node we label Rahu is the descending node
    # If omitted (None), server default is to treat Rahu as the descending node
    rahu_is_descending: Optional[bool] = None
    # No ayanamsha/node_type: we use J2000/IAU constellational pipeline by default
    house_system: str = "porphyry"

class Planet(BaseModel):
    name: str
    lon_sidereal: float
    sign: str
    house: int
    nakshatra: Optional[str]
    iau_constellation: str
    is_retrograde: bool
    sidereal_speed: float = 0.0  # Скорость долготы для всех тел
    house_progress: float = 0.0  # 0..1, положение внутри дома
    house_strength: float = 0.0  # 0..1, "колоколообразная" сила

class AspectLabel(BaseModel):
    planet: str
    from_house: int
    to_house: int
    houses_away: int
    label: str

class ConstellationArc(BaseModel):
    iau_code: str
    iau_name_ru: str
    lon_start_deg: float
    lon_end_deg: float

class PlanetConstellation(BaseModel):
    body: str
    iau_code: str
    iau_name_ru: str
    ra_deg_b1875: float
    dec_deg_b1875: float

class AscendantMC(BaseModel):
    sign: str
    degree: float
    lon_sidereal: float
    # When constellational mode is used, include IAU constellation info
    constellation_iau: str = ""
    constellation_name_ru: str = ""

class House(BaseModel):
    house: int
    sign: str

class NorthIndianBox(BaseModel):
    sign: str
    house: int
    bodies: List[str]
    aspects: List[AspectLabel] = Field(default_factory=list)

class NorthIndianLayout(BaseModel):
    boxes: List[NorthIndianBox]

class ChartResponse(BaseModel):
    # legacy ayanamsha/node_type removed — J2000/IAU constellational pipeline only
    ascendant: AscendantMC
    mc: AscendantMC
    planets: List[Planet]
    houses: List[House]
    north_indian_layout: NorthIndianLayout
    aspects: List[AspectLabel] = Field(default_factory=list)
    constellation_arcs: List[ConstellationArc] = Field(default_factory=list)
    planet_constellations: List[PlanetConstellation] = Field(default_factory=list)
    debug_info: dict = {}


class TextModerationRequest(BaseModel):
    text: str = Field(..., min_length=1)
    language_hint: Optional[str] = Field(
        default=None,
        description="ISO код языка, если нужно принудительно выбрать словарь",
    )


class TextModerationResponse(BaseModel):
    is_clean: bool
    matches: List[str] = Field(default_factory=list)
    censored_text: str
    model_label: Optional[str] = None
    model_confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    reasons: List[str] = Field(default_factory=list)


class ImageModerationResponse(BaseModel):
    label: Literal["safe", "unsafe"]
    is_clean: bool  # Renamed from is_explicit for consistency with frontend
    confidence: float = Field(..., ge=0.0, le=1.0)
    raw_scores: Dict[str, float] = Field(default_factory=dict)
    filename: Optional[str] = None
    reason: Optional[str] = None


class TithiRequest(BaseModel):
    datetime_iso: str = Field(..., description="ISO datetime with timezone offset, e.g. 2025-12-22T00:00:00+06:00")


class TithiResponse(BaseModel):
    tithi: int = Field(..., ge=1, le=30)
    paksha: Literal["shukla", "krishna"]
    start_utc: datetime
    end_utc: datetime
    phase_angle_deg: float = Field(..., ge=0.0, lt=360.0)
    illumination: float = Field(..., ge=0.0, le=1.0)


class SadeSatiRequest(BaseModel):
    moon_lon_deg: float = Field(..., ge=0.0, lt=360.0, description="Натальная долгота Луны λ(J2000), 0..360")
    reference_datetime_iso: str = Field(..., description="Точка отсчёта (ISO datetime с offset)")
    years_back: float = Field(default=0.0, ge=0.0, le=200.0)
    years_forward: float = Field(default=70.0, ge=0.0, le=200.0)
    step_days: float = Field(default=5.0, ge=0.25, le=30.0)
    merge_gap_days: float = Field(default=800.0, ge=0.0, le=2000.0)
    half_width_deg: float = Field(default=45.0, ge=1.0, le=90.0, description="Полуширина окна Саде-Сати (по лекции 45°)")


class SadeSatiSegment(BaseModel):
    start_utc: datetime
    end_utc: datetime


class SadeSatiPeriod(BaseModel):
    start_utc: datetime
    end_utc: datetime
    duration_days: float = Field(..., ge=0.0)
    segments: List[SadeSatiSegment] = Field(default_factory=list)


class SadeSatiResponse(BaseModel):
    moon_lon_deg: float
    half_width_deg: float
    start_boundary_lon_deg: float
    end_boundary_lon_deg: float
    reference_utc: datetime
    periods: List[SadeSatiPeriod] = Field(default_factory=list)
    selected_index: int = 0
    inside_selected: bool = False

# Пример использования moment-timezone для установки временной зоны и формата даты
# birth = '1987-02-21T18:45'
# ianaTz = 'Asia/Omsk' (или из профиля пользователя)
# const birthMoment = moment.tz(profile.birth, ianaTz);
# const offset = birthMoment.format('Z'); // '+06:00'
# const datetime_iso = `${birthMoment.format('YYYY-MM-DDTHH:mm:ss')}${offset}`;
