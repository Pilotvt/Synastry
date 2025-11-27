import os
import sys
from pathlib import Path


def _resolve_root() -> Path:
    env_root = os.getenv('SYN_RESOURCE_ROOT')
    if env_root:
        return Path(env_root)
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return Path(getattr(sys, '_MEIPASS'))
    return Path(__file__).resolve().parent.parent


def _discover_candidate_roots(base: Path) -> list[Path]:
    roots = [base]
    # Packaged builds keep large assets inside app.asar.unpacked/app, so include it if present.
    for suffix in ('app.asar.unpacked', 'app'):
        candidate = base / suffix
        if candidate.exists():
            roots.append(candidate)
    return roots


RESOURCE_ROOT = _resolve_root()
_CANDIDATE_ROOTS = _discover_candidate_roots(RESOURCE_ROOT)


def get_resource_root() -> Path:
    """Return the primary resolved root directory for bundled resources."""
    return RESOURCE_ROOT


def resource_path(*parts: str) -> Path:
    """Construct a path relative to known resource roots, preferring existing files."""
    for root in _CANDIDATE_ROOTS:
        candidate = root.joinpath(*parts)
        if candidate.exists():
            return candidate
    return _CANDIDATE_ROOTS[0].joinpath(*parts)
