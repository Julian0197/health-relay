#!/usr/bin/env python3
"""Check observer registration timing from DEBUG metadata, not health contents."""
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
launch = re.search(r"phase=didFinishLaunching observers=(\d+) expected=(\d+)", text)
assert launch, "Launch-phase observer diagnostic was not emitted"
observed, expected = map(int, launch.groups())
assert expected > 0, "Acceptance requires an enabled task with health-change triggers"
assert observed == expected, f"Only {observed}/{expected} health observers were registered at launch completion"
print(f"PASS: {observed}/{expected} observers registered before launch completed")
