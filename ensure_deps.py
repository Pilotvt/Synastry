import sys, subprocess, importlib, traceback

# Что ставим и какие минимальные версии считаем безопасными для Py3.12+
PKGS_MIN = {
    "pip": ">=24.0",
    "setuptools": ">=68",
    "wheel": ">=0.42",
    "numpy": ">=2.0",
    "scipy": ">=1.12",
    "astropy": ">=6.0",
    "skyfield": ">=1.49",
    "jplephem": ">=2.22",
    "pyswisseph": ">=2.10.03",
}

def run(cmd):
    print(">", " ".join(cmd))
    subprocess.check_call(cmd)

def pip_install(specs, only_binary=True, force_reinstall=False):
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade"]
    if only_binary:
        cmd += ["--only-binary", ":all:"]
    if force_reinstall:
        cmd += ["--force-reinstall", "--no-cache-dir"]
    cmd += specs
    run(cmd)

def ensure_base_tools():
    # Обновляем pip/setuptools/wheel прежде всего
    specs = [f"{k}{v}" for k, v in PKGS_MIN.items() if k in ("pip","setuptools","wheel")]
    try:
        pip_install(specs, only_binary=False)
    except subprocess.CalledProcessError:
        print("Не удалось обновить базовые инструменты.", file=sys.stderr)
        raise

def try_import(modname):
    try:
        return importlib.import_module(modname)
    except Exception as e:
        return e

def smoke_test():
    # 1) numpy
    import numpy as np
    assert np.isclose(np.array([1,2,3], dtype=float).mean(), 2.0)

    # 2) scipy (brentq)
    from scipy.optimize import brentq
    f = lambda x: x**2 - 2
    root = brentq(f, 1.0, 2.0)
    assert abs(root - 2**0.5) < 1e-10

    # 3) astropy - констелляция по простой точке
    from astropy.coordinates import SkyCoord, get_constellation
    import astropy.units as u
    c = SkyCoord(ra=0*u.deg, dec=0*u.deg, frame="icrs")
    name = get_constellation(c)
    assert isinstance(name, str) and len(name) > 0

    # 4) skyfield - базовый импорт и timescale без интернета
    from skyfield.api import load
    ts = load.timescale()
    _ = ts.utc(2016, 4, 17)

    # 5) pyswisseph
    import swisseph as swe
    _ = swe.version()

def ensure_pkgs():
    to_install = []
    for pkg, ver in PKGS_MIN.items():
        if pkg in ("pip","setuptools","wheel"):
            continue
        modname = pkg
        if pkg == "pyswisseph":
            modname = "swisseph"
        mod = try_import(modname)
        if isinstance(mod, Exception):
            print(f"[МОДУЛЬ НЕТ] {modname}: {mod}")
            to_install.append(f"{pkg}{ver}")
        else:
            print(f"[OK] {modname} установлен")

    if to_install:
        print("\nУстанавливаю/обновляю: ", ", ".join(to_install))
        # Сначала пробуем только бинарные колёса
        try:
            pip_install(to_install, only_binary=True)
        except subprocess.CalledProcessError:
            print("\nКолёса недоступны для некоторых пакетов. Повтор с обычной установкой...")
            pip_install(to_install, only_binary=False)

def main():
    print("=== Проверка/установка зависимостей для констелляционного расчёта ===")
    ensure_base_tools()
    ensure_pkgs()

    print("\n=== SMOKE-TEST (numpy, scipy, astropy, skyfield, pyswisseph) ===")
    try:
        smoke_test()
        print("[SMOKE-TEST] УСПЕХ: всё работает.")
        sys.exit(0)
    except Exception:
        print("[SMOKE-TEST] ОШИБКА:\n")
        traceback.print_exc()
        print("\nПробую принудительную переустановку проблемных пакетов (astropy/numpy/scipy)...")
        force_specs = [
            f"numpy{PKGS_MIN['numpy']}",
            f"scipy{PKGS_MIN['scipy']}",
            f"astropy{PKGS_MIN['astropy']}",
        ]
        try:
            pip_install(force_specs, only_binary=True, force_reinstall=True)
        except subprocess.CalledProcessError:
            pip_install(force_specs, only_binary=False, force_reinstall=True)

        # повторный тест
        try:
            smoke_test()
            print("[SMOKE-TEST] УСПЕХ после переустановки.")
            sys.exit(0)
        except Exception:
            print("[SMOKE-TEST] По-прежнему ошибка. Проверьте логи выше.")
            print("Если сборка идёт из исходников на Windows — установите Microsoft C++ Build Tools (Desktop development with C++).")
            sys.exit(1)

if __name__ == "__main__":
    main()
