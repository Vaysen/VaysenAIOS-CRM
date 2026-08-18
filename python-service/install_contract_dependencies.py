"""Install the minimal offline-contract dependencies from production pins."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REQUIRED_DISTRIBUTIONS = ("Flask", "Flask-Cors", "Pillow")
EXACT_REQUIREMENT = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?P<extras>\[[A-Za-z0-9,._-]+\])?"
    r"==(?P<version>[A-Za-z0-9][A-Za-z0-9.!+_-]*)$"
)


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def select_contract_requirements(requirements_path: Path) -> list[str]:
    required = {canonical_name(name): name for name in REQUIRED_DISTRIBUTIONS}
    selected: dict[str, str] = {}

    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = EXACT_REQUIREMENT.fullmatch(line)
        if not match:
            continue
        normalized = canonical_name(match.group("name"))
        if normalized not in required:
            continue
        if normalized in selected:
            raise SystemExit(f"duplicate production requirement for {required[normalized]}")
        selected[normalized] = line

    missing = sorted(set(required) - set(selected))
    if missing:
        names = ", ".join(required[name] for name in missing)
        raise SystemExit(f"production requirements are missing exact contract pins: {names}")
    return [selected[canonical_name(name)] for name in REQUIRED_DISTRIBUTIONS]


def main() -> None:
    requirements_path = Path(__file__).with_name("requirements.txt")
    selected = select_contract_requirements(requirements_path)
    print("Installing contract subset from production pins:", ", ".join(selected))
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            *selected,
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
