import argparse
import os
import subprocess
import sys
from pathlib import Path
import re


def run(cmd: list[str], *, allow_fail: bool = False) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0 and not allow_fail:
        raise subprocess.CalledProcessError(proc.returncode, cmd, output=proc.stdout, stderr=proc.stderr)
    return proc.returncode, out


def read_requirements(requirements_path: Path) -> list[str]:
    lines: list[str] = []
    for raw in requirements_path.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        lines.append(s)
    return lines


def try_parse_pinned_requirement(spec: str) -> tuple[str, str] | None:
    match = re.match(r"^\s*([A-Za-z0-9_.-]+)\s*==\s*([^\s;]+)\s*$", spec)
    if not match:
        return None
    name = match.group(1)
    version = match.group(2)
    return name, version


def has_wheel(dest: Path, name: str, version: str) -> bool:
    norm_name = name.replace("-", "_").lower()
    norm_version = version.lower()
    for wheel in dest.glob("*.whl"):
        parts = wheel.name.split("-")
        if len(parts) < 2:
            continue
        wheel_name = parts[0].replace("-", "_").lower()
        wheel_version = parts[1].lower()
        if wheel_name == norm_name and wheel_version == norm_version:
            return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a local wheelhouse for offline installs.")
    parser.add_argument("--dest", required=True, help="Destination folder for wheels (e.g. electron/resources/wheels)")
    parser.add_argument("--requirements", required=True, help="Path to requirements.txt")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete existing *.whl/*.tar.gz/*.zip in the destination before downloading.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail if any requirement can't be produced as a wheel (downloaded or locally built).",
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
    base_download = [*pip, "download", "--dest", str(dest), "--only-binary", ":all:", "--prefer-binary"]
    base_wheel = [*pip, "wheel", "--wheel-dir", str(dest), "--no-deps"]

    # Ensure we always have a pip wheel available for embedded builds without ensurepip.
    try:
        run([*base_download, "--no-deps", "pip", "setuptools", "wheel"])
    except subprocess.CalledProcessError as exc:
        stdout = exc.output or ""
        stderr = exc.stderr or ""
        print("[wheelhouse] Failed to download pip/setuptools/wheel as wheels.")
        if stdout.strip():
            print(stdout.strip())
        if stderr.strip():
            print(stderr.strip())
        raise

    requirements = read_requirements(req)
    failures: list[str] = []
    for spec in requirements:
        pinned = try_parse_pinned_requirement(spec)
        if pinned:
            name, version = pinned
            if has_wheel(dest, name, version):
                print(f"[wheelhouse] Reusing existing wheel for {name}=={version}")
                continue

        code, out = run([*base_download, spec], allow_fail=True)
        if code == 0:
            continue

        # Some packages (e.g. pyswisseph) don't publish cp312 wheels on PyPI.
        print(f"[wheelhouse] No prebuilt wheel for {spec}; trying to build locally from sdist...")
        code2, out2 = run([*base_wheel, spec], allow_fail=True)
        if code2 == 0:
            continue

        failures.append(spec)
        print(f"[wheelhouse] FAILED to produce wheel for {spec}")
        print(out.strip())
        print(out2.strip())

    # Keep folder present in git even if wheels are generated elsewhere.
    readme = dest / "README.txt"
    if not readme.exists():
        readme.write_text(
            "This folder is packaged into the app as resources/wheels.\n"
            "Run `npm run wheels:prepare` before `npm run dist` to populate it.\n"
            "Set SYN_SKIP_WHEELHOUSE=1 to skip wheelhouse generation.\n",
            encoding="utf-8",
        )

    if failures:
        msg = "[wheelhouse] Some requirements were not packaged as wheels:\n- " + "\n- ".join(failures)
        if args.strict:
            raise SystemExit(msg)
        print(msg)

    print(f"[wheelhouse] OK: {dest}")


if __name__ == "__main__":
    main()
