import os
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


def main():
    ensure_env()
    install_requirements()


if __name__ == "__main__":
    main()
