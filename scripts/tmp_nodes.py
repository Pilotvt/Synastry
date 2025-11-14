import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from app.schemas import ChartRequest
from app.jyotish import compute_chart

req = ChartRequest(
    datetime_iso="1987-01-26T05:00:00+00:00",
    latitude=55.7558,
    longitude=37.6173,
    elevation_m=0.0,
    house_system="porphyry"
)
chart = compute_chart(req)
for p in chart.planets:
    if p.name in ("Ra","Ke"):
        print(p.name, p.lon_sidereal, p.sign, p.iau_constellation)
