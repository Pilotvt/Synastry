from app.jyotish import compute_chart, ChartRequest
res = compute_chart(ChartRequest(datetime_iso='2016-04-17T08:00', latitude=48.708, longitude=44.513, elevation_m=0.0, house_system='porphyry', constellational=True))
print(res.debug_info['datetime_utc'])
