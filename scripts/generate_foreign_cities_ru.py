import argparse
import csv
import json
import sys
import zipfile
from io import TextIOWrapper
from pathlib import Path
from urllib.request import urlretrieve

GEONAMES_BASE_URL = "https://download.geonames.org/export/dump"
GEONAMES_FILES = {
    "cities1000.zip": f"{GEONAMES_BASE_URL}/cities1000.zip",
    "alternateNamesV2.zip": f"{GEONAMES_BASE_URL}/alternateNamesV2.zip",
}


def format_coord(value: float) -> str:
    rounded = round(value, 5)
    return f"{rounded:.5f}"


def make_key(country: str, name: str, lat: float, lon: float) -> str:
    return f"{country}|{name}|{format_coord(lat)}|{format_coord(lon)}"


NON_RUSSIAN_LETTERS = set("\u0456\u0406\u0457\u0407\u0454\u0404\u0491\u0490\u045E\u040E")


def contains_cyrillic(value: str) -> bool:
    return any("А" <= ch <= "я" or ch in ("Ё", "ё") for ch in value)


def is_russian_only(value: str) -> bool:
    for ch in value:
        if not ch.isalpha():
            continue
        if ch in NON_RUSSIAN_LETTERS:
            return False
        if not ("А" <= ch <= "я" or ch in ("Ё", "ё")):
            return False
    return True


OVERRIDES = {
    make_key("US", "Miami", 25.77427, -80.19366): "\u041c\u0430\u0439\u0430\u043c\u0438",
}


def download_if_missing(url: str, dest: Path, force: bool) -> None:
    if dest.exists() and not force:
        return
    if dest.exists():
        dest.unlink()
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} -> {dest}", file=sys.stderr)
    urlretrieve(url, dest)


def load_city_keys(cities_dir: Path) -> set[str]:
    keys: set[str] = set()
    for path in sorted(cities_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            country = str(item.get("country", "")).upper()
            if not country or country == "RU":
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            lat_raw = item.get("lat")
            lon_raw = item.get("lon")
            try:
                lat = float(lat_raw)
                lon = float(lon_raw)
            except (TypeError, ValueError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            keys.add(make_key(country, name, lat, lon))
    return keys


def map_geoname_ids(cities_zip: Path, keys: set[str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    key_to_id: dict[str, str] = {}
    id_to_keys: dict[str, list[str]] = {}
    matched = 0
    collisions = 0
    with zipfile.ZipFile(cities_zip) as zf:
        with zf.open("cities1000.txt") as raw:
            reader = csv.reader(TextIOWrapper(raw, encoding="utf-8"), delimiter="\t")
            for row in reader:
                if len(row) < 9:
                    continue
                geoname_id = row[0].strip()
                if not geoname_id:
                    continue
                name = row[1].strip()
                asciiname = row[2].strip()
                try:
                    lat = float(row[4])
                    lon = float(row[5])
                except (TypeError, ValueError):
                    continue
                country = row[8].strip().upper()
                if not country:
                    continue

                for candidate in (name, asciiname):
                    if not candidate:
                        continue
                    key = make_key(country, candidate, lat, lon)
                    if key not in keys:
                        continue
                    if key in key_to_id:
                        if key_to_id[key] != geoname_id:
                            collisions += 1
                        continue
                    key_to_id[key] = geoname_id
                    id_to_keys.setdefault(geoname_id, []).append(key)
                    matched += 1

    print(
        f"GeoNames mapping: matched {matched} keys, collisions {collisions}",
        file=sys.stderr,
    )
    return key_to_id, id_to_keys


def load_ru_names(alt_zip: Path, id_to_keys: dict[str, list[str]]) -> dict[str, str]:
    best: dict[str, tuple[int, str]] = {}
    with zipfile.ZipFile(alt_zip) as zf:
        with zf.open("alternateNamesV2.txt") as raw:
            reader = csv.reader(TextIOWrapper(raw, encoding="utf-8"), delimiter="\t")
            for row in reader:
                if len(row) < 8:
                    continue
                geoname_id = row[1].strip()
                if geoname_id not in id_to_keys:
                    continue
                lang = row[2].strip().lower()
                if not lang.startswith("ru"):
                    continue
                name = row[3].strip()
                if not name or not contains_cyrillic(name):
                    continue
                is_preferred = row[4].strip() == "1"
                is_short = row[5].strip() == "1"
                is_colloquial = row[6].strip() == "1"
                is_historic = row[7].strip() == "1"
                if is_historic:
                    continue

                base_score = 0 if is_preferred else 1 if is_short else 2
                score = base_score + (0 if is_russian_only(name) else 2)
                if is_colloquial and not is_preferred:
                    score += 1

                prev = best.get(geoname_id)
                if prev is None:
                    best[geoname_id] = (score, name)
                    continue
                prev_score, prev_name = prev
                if score < prev_score or (score == prev_score and len(name) < len(prev_name)):
                    best[geoname_id] = (score, name)

    return {geoname_id: name for geoname_id, (score, name) in best.items()}


def write_output(output_path: Path, id_to_keys: dict[str, list[str]], ru_names: dict[str, str]) -> None:
    output: dict[str, str] = {}
    for geoname_id, keys in id_to_keys.items():
        name = ru_names.get(geoname_id)
        if not name:
            continue
        for key in keys:
            output[key] = name

    output.update(OVERRIDES)
    ordered = {key: output[key] for key in sorted(output)}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(ordered, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Written {len(ordered)} translated cities to {output_path}",
        file=sys.stderr,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate ru names map for foreign cities.")
    parser.add_argument(
        "--cities-dir",
        type=Path,
        default=Path("public/cities-by-country"),
        help="Path to cities-by-country directory.",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("data/geonames"),
        help="Directory for downloaded GeoNames files.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/cities-ru/foreign-cities-ru.json"),
        help="Output JSON path.",
    )
    parser.add_argument("--redownload", action="store_true", help="Force re-download of GeoNames files.")
    args = parser.parse_args()

    if not args.cities_dir.exists():
        print(f"Cities directory not found: {args.cities_dir}", file=sys.stderr)
        return 1

    for filename, url in GEONAMES_FILES.items():
        download_if_missing(url, args.cache_dir / filename, args.redownload)

    print("Loading city keys...", file=sys.stderr)
    keys = load_city_keys(args.cities_dir)
    print(f"Loaded {len(keys)} foreign city keys.", file=sys.stderr)

    cities_zip = args.cache_dir / "cities1000.zip"
    alt_zip = args.cache_dir / "alternateNamesV2.zip"

    print("Mapping GeoNames IDs...", file=sys.stderr)
    _, id_to_keys = map_geoname_ids(cities_zip, keys)

    print("Loading ru alternate names...", file=sys.stderr)
    ru_names = load_ru_names(alt_zip, id_to_keys)
    print(f"Collected {len(ru_names)} ru names.", file=sys.stderr)

    write_output(args.output, id_to_keys, ru_names)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
