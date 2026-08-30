"""Application release version, sourced from the repository VERSION file."""

from pathlib import Path


def _read_version() -> str:
    app_file = Path(__file__).resolve()
    # Local checkout: <repo>/backend/app/version.py -> <repo>/VERSION.
    # Docker image:   /app/app/version.py -> /app/VERSION.
    for candidate in (app_file.parents[2] / "VERSION", app_file.parents[1] / "VERSION"):
        try:
            value = candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value

    raise RuntimeError("Application VERSION file is missing or empty")


APP_VERSION = _read_version()
