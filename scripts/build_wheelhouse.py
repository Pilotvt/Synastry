import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    subprocess.check_call(cmd)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a local wheelhouse for offline installs.")
    parser.add_argument("--dest", required=True, help="Destination folder for wheels (e.g. electron/resources/wheels)")
    parser.add_argument("--requirements", required=True, help="Path to requirements.txt")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete existing *.whl/*.tar.gz/*.zip in the destination before downloading.",
    )
    args = parser.parse_args()

    if os.environ.get("SYN_SKIP_WHEELHOUSE") == "1":
        print("[wheelhouse] SYN_SKIP_WHEELHOUSE=1, skipping")
        return

    root = Path(__file__).resolve().parents[1]
    dest = (root / args.dest).resolve()
    req = (root / args.requirements).resolve()

    if not req.exists():
        raise SystemExit(f"[wheelhouse] requirements file not found: {req}")

    dest.mkdir(parents=True, exist_ok=True)

    if args.clean:
        for pat in ("*.whl", "*.zip", "*.tar.gz"):
            for p in dest.glob(pat):
                try:
                    p.unlink()
                except OSError:
                    pass

    pip = [sys.executable, "-m", "pip"]
    base_download = [
        *pip,
        "download",
        "--dest",
        str(dest),
        "--only-binary",
        ":all:",
        "--prefer-binary",
        "--platform",
        "win_amd64",
        "--implementation",
        "cp",
        "--python-version",
        "312",
        "--abi",
        "cp312",
    ]

    # Ensure we always have a pip wheel available for embedded builds without ensurepip.
    run([*base_download, "pip", "setuptools", "wheel"])
    run([*base_download, "-r", str(req)])

    # Keep folder present in git even if wheels are generated elsewhere.
    readme = dest / "README.txt"
    if not readme.exists():
        readme.write_text(
            "This folder is packaged into the app as resources/wheels.\n"
            "Run `npm run wheels:prepare` before `npm run dist` to populate it.\n"
            "Set SYN_SKIP_WHEELHOUSE=1 to skip wheelhouse generation.\n",
            encoding="utf-8",
        )

    print(f"[wheelhouse] OK: {dest}")


if __name__ == "__main__":
    main()

