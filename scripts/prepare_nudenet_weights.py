"""Download NudeNet Lite weights into the packaged python environment."""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import urllib.request
from urllib.error import HTTPError, URLError
from pathlib import Path

DEFAULT_URL = "https://github.com/notAI-tech/NudeNet/releases/download/v0/classifier_lite.onnx"
EXPECTED_SHA256 = os.environ.get(
    "NUDENET_LITE_SHA256",
    "20c251954cc8c0d24dd47cebb6a42199c38ef9f33b7f5a82905a3404d8d46953",
)
USER_AGENT = "synastry-backend-setup/1.0"


def _download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        request = urllib.request.Request(url, headers=_request_headers())
        with urllib.request.urlopen(request) as response, tmp_path.open("wb") as writer:
            shutil.copyfileobj(response, writer)

        if _looks_like_html(tmp_path):
            raise RuntimeError(
                "Received HTML instead of NudeNet weights (GitHub may require authentication). "
                "Set GH_TOKEN/GITHUB_TOKEN or NUDENET_LITE_URL to a reachable mirror."
            )

        if EXPECTED_SHA256:
            digest = _sha256(tmp_path)
            if digest.lower() != EXPECTED_SHA256.lower():
                raise RuntimeError(
                    "Checksum mismatch while downloading NudeNet weights:"
                    f" expected {EXPECTED_SHA256}, got {digest}"
                )
        shutil.move(str(tmp_path), destination)
    except (HTTPError, URLError) as exc:
        raise RuntimeError(
            f"Failed to download NudeNet weights from {url}: {exc}. "
            "GitHub may block unauthenticated downloads. "
            "Set GH_TOKEN/GITHUB_TOKEN or NUDENET_LITE_URL to a mirror."
        ) from exc
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _request_headers() -> dict:
    headers = {"User-Agent": USER_AGENT}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _looks_like_html(path: Path) -> bool:
    # GitHub redirects NSFW assets to a login page when unauthenticated; avoid
    # silently storing that HTML as a model file.
    try:
        start = path.read_bytes()[:64].lower()
    except OSError:
        return False
    return b"<html" in start or b"<!doctype html" in start


def ensure_weights() -> Path:
    import nudenet  # type: ignore

    package_dir = Path(nudenet.__file__).resolve().parent
    dest = package_dir / "classifier_lite.onnx"
    if dest.exists():
        return dest

    url = os.environ.get("NUDENET_LITE_URL", DEFAULT_URL)
    print(f"[prepare_nudenet_weights] downloading NudeNet weights from {url}")
    _download(url, dest)
    print(f"[prepare_nudenet_weights] stored NudeNet weights at {dest}")
    return dest


def main() -> None:
    ensure_weights()


if __name__ == "__main__":
    main()
