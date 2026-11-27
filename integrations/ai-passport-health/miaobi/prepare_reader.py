#!/usr/bin/env python3
"""Render fixed private Base coordinates into a deployable Magic FaaS source file."""
import argparse
import json
from pathlib import Path
import re
import sys

PLACEHOLDERS = {"base": "example_base", "table": "example_table", "record": "example_record"}


def render(config):
    if not isinstance(config, dict) or set(config) != set(PLACEHOLDERS):
        raise ValueError("expected base, table and record")
    source = Path(__file__).with_name("badge-cache-reader.cjs").read_text()
    for name, placeholder in PLACEHOLDERS.items():
        value = config[name]
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
            raise ValueError("invalid deployment coordinate")
        source = source.replace("'" + placeholder + "'", json.dumps(value))
    return source


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="owner-only JSON with base/table/record")
    parser.add_argument("--output", type=Path, required=True, help="new private output file; existing files are preserved")
    args = parser.parse_args(argv)
    try:
        if args.config.stat().st_mode & 0o077 or args.config.stat().st_size > 2048:
            raise ValueError("configuration must be private")
        source = render(json.loads(args.config.read_text()))
        # Exclusive create keeps an existing deployment file intact.
        import os
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(source)
    except (OSError, ValueError):
        print("Reader preparation failed; check private config and output path.", file=sys.stderr)
        return 1
    print("Reader source prepared; publish it as a new HTTP FaaS and grant Base read access.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
