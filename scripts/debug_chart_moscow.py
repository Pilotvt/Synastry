import sys
import json
from pathlib import Path

# ensure project root is importable
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.jyotish import compute_chart
from app.schemas import ChartRequest

def main():
    # Moscow coords, local time 1987-01-26 08:00 (naive local time)
    req = ChartRequest(datetime_iso="1987-01-26T08:00:00", latitude=55.7558, longitude=37.6176, elevation_m=0)
    chart = compute_chart(req)

    out = {
        'ascendant': {
            'iau_code': chart.debug_info.get('asc_iau_code'),
            'iau_name_ru': chart.debug_info.get('asc_iau_name_ru'),
            'lon_sidereal': chart.debug_info.get('asc_lon_sidereal'),
            'mapped_sign': chart.debug_info.get('asc_mapped_sign'),
        },
        'planets': [],
        'houses': [h.model_dump() for h in chart.houses],
        'north_indian_layout': chart.north_indian_layout.model_dump(),
        'aspects': [a.model_dump() for a in chart.aspects],
        'nodes': chart.debug_info.get('nodes'),
        'nodes_method': chart.debug_info.get('nodes_method_used'),
    }

    for p in chart.planets:
        out['planets'].append({
            'name': p.name,
            'lon_sidereal': p.lon_sidereal,
            'iau_constellation': p.iau_constellation,
            'sign': p.sign,
            'house': p.house,
            'is_retrograde': p.is_retrograde,
            'sidereal_speed': p.sidereal_speed,
        })

    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
