import sys
import os
from pathlib import Path

# Ensure project root is on sys.path so `app` package imports work when running
# this script directly.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.jyotish import compute_chart
from app.schemas import ChartRequest
import json

cases = [
    # Volgograd 2016-04-17T08:00 Europe/Volgograd
    ChartRequest(datetime_iso='2016-04-17T08:00:00+03:00', latitude=48.7080, longitude=44.5133, elevation_m=100, rahu_is_descending=None),
    # Moscow 2025-01-26T08:00 Europe/Moscow
    ChartRequest(datetime_iso='2025-01-26T08:00:00+03:00', latitude=55.7558, longitude=37.6173, elevation_m=144, rahu_is_descending=None),
]

for c in cases:
    print('--- Case:', c.datetime_iso, c.latitude, c.longitude)
    resp = compute_chart(c)
    nodes = resp.debug_info.get('nodes', {})
    method = resp.debug_info.get('nodes_method_used')
    print('nodes_method_used=', method)
    print('Rahu lon (raw) =', nodes.get('Rahu'))
    print('Ketu lon (raw) =', nodes.get('Ketu'))
    print('Planets houses:')
    for p in resp.planets:
        if p.name in ('Ra','Ke'):
            print(' ', p.name, 'house=', p.house, 'lon_sid=', p.lon_sidereal)
    print('houses: ', [(h.house, h.sign) for h in resp.houses])
    print('debug rahu_is_desc override in req:', c.rahu_is_descending)
    print()
