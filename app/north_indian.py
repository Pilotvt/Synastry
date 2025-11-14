from typing import Dict, List, Optional

SIGNS = ["Ar", "Ta", "Ge", "Cn", "Le", "Vi", "Li", "Sc", "Sg", "Cp", "Aq", "Pi"]
PLANET_ABBR = ["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke"]

# Порядок домов для северо-индийской схемы:
# начинаем с верхнего ромба (1-й дом) и идём против часовой стрелки.
HOUSES_CCW_FROM_TOP = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]


def north_indian_layout(
    house_signs: List[str],
    planets: List[Dict],
    house_aspects: Optional[Dict[int, List[Dict]]] = None,
) -> Dict:
    """
    Формирует структуру из 12 боксов (домов) для северо-индийской карты.
    :param house_signs: знаки по домам (индекс 1 соответствует дому 1 и т.д.)
    :param planets: список планет, каждая с полем sign (знак) и name (аббревиатура)
    """
    boxes = []
    for house in HOUSES_CCW_FROM_TOP:
        # house_signs приходит в порядке домов 1..12, поэтому индекс = house-1
        sign = house_signs[house - 1]
        # Place bodies by their computed numeric house to ensure consistency
        # with server-side houseIndex values (planets provide 'house').
        bodies = [p["name"] for p in planets if int(p.get("house", 0)) == house]
        aspects = house_aspects.get(house, []) if house_aspects else []
        boxes.append({"sign": sign, "house": house, "bodies": bodies, "aspects": aspects})
    return {"boxes": boxes}
