import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_DIR = ROOT / "python-env"

PYTHON = Path(sys.executable)


def ensure_env():
    if ENV_DIR.exists():
        return
    subprocess.check_call([str(PYTHON), "-m", "venv", str(ENV_DIR)])


def python_in_env() -> Path:
    scripts_dir = "Scripts" if os.name == "nt" else "bin"
    exe = "python.exe" if os.name == "nt" else "python"
    return ENV_DIR / scripts_dir / exe


def install_requirements():
    py_path = python_in_env()

    def run_pip(*args):
        cmd = [str(py_path), "-m", "pip", *args]
        subprocess.check_call(cmd)

    try:
        run_pip("install", "--upgrade", "pip")
    except subprocess.CalledProcessError as exc:
        print("[build_backend_env] pip upgrade failed, continuing:", exc)

    run_pip("install", "--upgrade", "wheel", "setuptools")
    req_file = ROOT / "requirements.txt"
    run_pip("install", "-r", str(req_file))

    warm_fasttext_model(py_path)


def warm_fasttext_model(py_path: Path) -> None:
    module = "app.moderation.fasttext_model"
    subprocess.check_call(
        [str(py_path), "-m", module, "--train"],
        cwd=ROOT,
    )


def copy_runtime_dlls() -> None:
    """Ensure the embedded env has all runtime DLLs to run on clean machines."""
    base_python = Path(sys.base_prefix)
    dll_candidates = [
        f"python{sys.version_info.major}{sys.version_info.minor}.dll",
        "python3.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
    ]

    for dll_name in dll_candidates:
        src = base_python / dll_name
        if not src.exists():
            continue
        dst = ENV_DIR / dll_name
        try:
            shutil.copy2(src, dst)
        except OSError as exc:
            print(f"[build_backend_env] Failed to copy {src} -> {dst}: {exc}")


def patch_pyvenv_cfg() -> None:
    """Make pyvenv.cfg portable for packaged builds."""
    cfg_path = ENV_DIR / "pyvenv.cfg"
    if not cfg_path.exists():
        return
    rel_exe = ".\\Scripts\\python.exe" if os.name == "nt" else "./bin/python"
    try:
        cfg_path.write_text(
            "\n".join(
                [
                    "home = .",
                    "include-system-site-packages = false",
                    f"version = {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                    f"executable = {rel_exe}",
                    f"command = {rel_exe} -m venv .",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"[build_backend_env] Failed to patch pyvenv.cfg: {exc}")


def main():
    ensure_env()
    copy_runtime_dlls()
    install_requirements()
    patch_pyvenv_cfg()


if __name__ == "__main__":
    main()
