"""CLI for IAU constellation classification."""
from __future__ import annotations

import argparse

from .classify.point_in_constellation import classify_planets
from .classify.ecliptic_arcs_j2000 import compute_ecliptic_arcs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Classify planets into IAU constellations")
    parser.add_argument(
        "--utc",
        required=True,
        help="UTC datetime in ISO format, e.g. 1985-06-06T00:45:00Z",
    )
    parser.add_argument(
        "--show-arcs",
        action="store_true",
        help="Print ecliptic arcs table as well",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    rows = classify_planets(args.utc)
    print("body\tiau_code\tiau_name_ru\tra_deg_b1875\tdec_deg_b1875")
    for row in rows:
        print(
            f"{row['body']}\t{row['iau_code']}\t{row['iau_name_ru']}\t"
            f"{row['ra_deg_b1875']:.6f}\t{row['dec_deg_b1875']:.6f}"
        )
    if args.show_arcs:
        print("\nEcliptic arcs (J2000):")
        for arc in compute_ecliptic_arcs():
            print(
                f"{arc['iau_code']} ({arc['iau_name_ru']}): "
                f"{arc['lon_start_deg']:.3f}° – {arc['lon_end_deg']:.3f}°"
            )


if __name__ == "__main__":  # pragma: no cover
    main()
