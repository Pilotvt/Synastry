"""Download NudeNet 640m model into app/nudenet for packaging.

GitHub sometimes serves an HTML/login page for NSFW assets when downloading from
github.com directly. This script prefers the GitHub API when a token is set.

Set GH_TOKEN or GITHUB_TOKEN to a token that can read public repositories.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

DEFAULT_URL = "https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/640m.onnx"
REPO = "notAI-tech/NudeNet"
RELEASE_TAG = "v3.4-weights"
ASSET_NAME = "640m.onnx"
USER_AGENT = "synastry-nudenet-model-downloader/1.0"


def _request_headers() -> dict:
    headers = {"User-Agent": USER_AGENT}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _looks_like_html(path: Path) -> bool:
    try:
        start = path.read_bytes()[:128].lower()
    except OSError:
        return False
    return b"<html" in start or b"<!doctype html" in start


def _sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        request = urllib.request.Request(url, headers=_request_headers())
        with urllib.request.urlopen(request) as response, tmp_path.open("wb") as writer:
            shutil.copyfileobj(response, writer)

        if _looks_like_html(tmp_path):
            raise RuntimeError(
                "Received HTML instead of 640m.onnx (GitHub likely blocked unauthenticated download). "
                "Set GH_TOKEN/GITHUB_TOKEN and retry."
            )

        shutil.move(str(tmp_path), destination)
    except (HTTPError, URLError) as exc:
        raise RuntimeError(f"Failed to download NudeNet 640m weights from {url}: {exc}") from exc
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)

def _github_api_headers(extra: dict | None = None) -> dict:
    headers = _request_headers()
    headers.setdefault("Accept", "application/vnd.github+json")
    if extra:
        headers.update(extra)
    return headers


def _github_api_get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers=_github_api_headers())
    with urllib.request.urlopen(request) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def _github_download_release_asset(destination: Path) -> bool:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        return False

    release_url = f"https://api.github.com/repos/{REPO}/releases/tags/{RELEASE_TAG}"
    data = _github_api_get_json(release_url)
    assets = data.get("assets") or []
    asset = next((a for a in assets if a.get("name") == ASSET_NAME), None)
    if not asset:
        names = [a.get("name") for a in assets if a.get("name")]
        raise RuntimeError(
            f"GitHub release asset '{ASSET_NAME}' not found in {REPO}@{RELEASE_TAG}. "
            f"Available: {', '.join(names[:20])}"
        )
    asset_id = asset.get("id")
    if not asset_id:
        raise RuntimeError("GitHub API did not return asset id for 640m.onnx")

    download_url = f"https://api.github.com/repos/{REPO}/releases/assets/{asset_id}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        request = urllib.request.Request(
            download_url,
            headers=_github_api_headers({"Accept": "application/octet-stream"}),
        )
        with urllib.request.urlopen(request) as response, tmp_path.open("wb") as writer:
            shutil.copyfileobj(response, writer)

        if _looks_like_html(tmp_path):
            raise RuntimeError(
                "Received HTML instead of 640m.onnx from GitHub API download. Token may be missing/invalid."
            )
        shutil.move(str(tmp_path), destination)
        return True
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    dest = root / "app" / "nudenet" / "640m.onnx"
    url = os.environ.get("NUDENET_640M_URL", DEFAULT_URL)
    print(f"[download_nudenet_640m] downloading from: {url}")
    try:
        used_api = _github_download_release_asset(dest)
    except Exception as exc:
        raise RuntimeError(
            "Failed to download 640m.onnx via GitHub API. "
            "Make sure GH_TOKEN/GITHUB_TOKEN is set in the SAME terminal where you run the command."
        ) from exc

    if not used_api:
        download(url, dest)
    print(f"[download_nudenet_640m] stored: {dest}")
    print(f"[download_nudenet_640m] size: {dest.stat().st_size} bytes")
    print(f"[download_nudenet_640m] sha256: {_sha256(dest)}")


if __name__ == "__main__":
    main()
