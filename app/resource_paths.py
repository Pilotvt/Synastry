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


RESOURCE_ROOT = _resolve_root()


def get_resource_root() -> Path:
    """Return the resolved root directory for bundled resources."""
    return RESOURCE_ROOT


def resource_path(*parts: str) -> Path:
    """Construct a path relative to the resource root."""
    return RESOURCE_ROOT.joinpath(*parts)
