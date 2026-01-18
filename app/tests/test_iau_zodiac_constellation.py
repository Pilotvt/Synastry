import unittest

from app.jyotish import compute_chart
from app.schemas import ChartRequest


class TestIauZodiacConstellation(unittest.TestCase):
    def test_venus_true_cet_but_sign_follows_zodiac(self) -> None:
        req = ChartRequest(
            datetime_iso="1987-04-28T18:00:00+06:00",
            latitude=54.8415,
            longitude=73.3017,
            elevation_m=0,
        )
        resp = compute_chart(req)
        venus = next(p for p in resp.planets if p.name == "Ve")

        self.assertEqual(venus.iau_constellation, "Cet")
        self.assertEqual(venus.sign, "Pi")
        self.assertEqual(venus.house, 7)

