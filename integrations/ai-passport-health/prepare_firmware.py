#!/usr/bin/env python3
"""Prepare the pinned upstream source and apply this application's patch."""
import argparse
from pathlib import Path
import subprocess

UPSTREAM = "https://github.com/FoloToy/ai-passport.git"
REVISION = "3d685a90bdb96dd8526d84edde1e63fec25b460e"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new directory; existing paths are preserved")
    args = parser.parse_args()
    target = args.destination.resolve()
    target.mkdir(parents=True, exist_ok=False)
    patch = Path(__file__).with_name("firmware.patch")
    subprocess.run(["git", "init", str(target)], check=True)
    for command in [
        ["remote", "add", "origin", UPSTREAM],
        ["fetch", "--depth", "1", "origin", REVISION],
        ["switch", "-c", "codex/health-dashboard", "FETCH_HEAD"],
        ["apply", str(patch)],
    ]:
        subprocess.run(["git", "-C", str(target)] + command, check=True)
    print("Prepared source: " + str(target))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
