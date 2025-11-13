from pydantic import BaseModel, Field
from typing import List, Optional

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

# Пример использования moment-timezone для установки временной зоны и формата даты
# birth = '1987-02-21T18:45'
# ianaTz = 'Asia/Omsk' (или из профиля пользователя)
# const birthMoment = moment.tz(profile.birth, ianaTz);
# const offset = birthMoment.format('Z'); // '+06:00'
# const datetime_iso = `${birthMoment.format('YYYY-MM-DDTHH:mm:ss')}${offset}`;
