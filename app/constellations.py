from astropy.coordinates import SkyCoord
from astropy import units as u
from astropy.coordinates import get_constellation

def resolve_constellation(ra_deg: float, dec_deg: float) -> str:
    coord = SkyCoord(ra=ra_deg * u.degree, dec=dec_deg * u.degree, frame='icrs')
    return get_constellation(coord)
