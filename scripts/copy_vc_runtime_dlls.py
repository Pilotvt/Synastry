import argparse
import os
import shutil
import sys
from pathlib import Path


DLL_NAMES = [
    # Core MSVC runtime
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    # STL / runtime bits frequently required by native wheels (numpy/onnxruntime/etc.)
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "concrt140.dll",
    "vcomp140.dll",
]

PYTHON_RUNTIME_DLL = "python312.dll"


def find_system_dirs() -> list[Path]:
    sysroot = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    return [
        Path(sysroot) / "System32",
        Path(sysroot) / "SysWOW64",
        Path(sys.base_prefix),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Copy VC++ runtime DLLs into python-embed for clean machines.")
    parser.add_argument("--dest", required=True, help="Destination folder (e.g. electron/resources/python-embed)")
    parser.add_argument("--strict", action="store_true", help="Fail if any DLL is missing on this build machine.")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing DLLs in destination (by default only missing DLLs are copied).",
    )
    args = parser.parse_args()

    if os.environ.get("SYN_SKIP_VC_DLLS") == "1":
        print("[vc-dlls] SYN_SKIP_VC_DLLS=1, skipping")
        return

    root = Path(__file__).resolve().parents[1]
    dest = (root / args.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    src_dirs = find_system_dirs()
    missing: list[str] = []

    for name in DLL_NAMES:
        src = next((d / name for d in src_dirs if (d / name).exists()), None)
        if not src or not src.exists():
            missing.append(name)
            continue
        dst = dest / name
        if dst.exists() and not args.overwrite:
            print(f"[vc-dlls] exists, keep: {dst}")
            continue
        try:
            shutil.copy2(src, dst)
            print(f"[vc-dlls] {name} <- {src}")
        except OSError as exc:
            raise SystemExit(f"[vc-dlls] failed to copy {src} -> {dst}: {exc}") from exc

    # Ensure the actual CPython runtime DLL is bundled next to python.exe.
    # Without it, embedded python will crash on startup on machines without a system Python installation.
    python_runtime_srcs: list[Path] = [
        root / "python-env" / PYTHON_RUNTIME_DLL,
        *[d / PYTHON_RUNTIME_DLL for d in src_dirs],
    ]
    python_runtime_src = next((p for p in python_runtime_srcs if p.exists()), None)
    python_runtime_dst = dest / PYTHON_RUNTIME_DLL
    if python_runtime_dst.exists() and not args.overwrite:
        print(f"[vc-dlls] exists, keep: {python_runtime_dst}")
    else:
        if not python_runtime_src or not python_runtime_src.exists():
            missing.append(PYTHON_RUNTIME_DLL)
        else:
            try:
                shutil.copy2(python_runtime_src, python_runtime_dst)
                print(f"[vc-dlls] {PYTHON_RUNTIME_DLL} <- {python_runtime_src}")
            except OSError as exc:
                raise SystemExit(
                    f"[vc-dlls] failed to copy {python_runtime_src} -> {python_runtime_dst}: {exc}"
                ) from exc

    if missing:
        msg = (
            "[vc-dlls] missing on this machine:\n- "
            + "\n- ".join(missing)
            + "\nIf the missing DLL is a VC++ runtime, install Microsoft Visual C++ Redistributable 2015-2022 (x64):\n"
            + "https://aka.ms/vs/17/release/vc_redist.x64.exe"
        )
        if args.strict:
            raise SystemExit(msg)
        print(msg)


if __name__ == "__main__":
    main()
