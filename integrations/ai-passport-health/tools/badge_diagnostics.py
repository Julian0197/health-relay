#!/usr/bin/env python3
"""Read operating diagnostics without resetting the badge or writing settings."""
import argparse
import json
import os
from pathlib import Path
import re
import select
import time

from health_bridge import SerialLink, encode_frame, write_all

FIELDS = frozenset((
    "v", "uptime_ms", "battery_pct", "battery_mv", "rssi_dbm", "pm_enabled",
    "screen_locked", "screen_off", "panel_asleep", "usb_host", "wifi_link",
    "network_state", "wifi_attempts", "wifi_disconnects", "fetch_attempts",
    "fetch_failures", "pm_error", "panel_error", "reset_reason", "free_heap",
))


def summarize(raw):
    text = raw.decode("utf-8", errors="replace")
    records = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get("event") == "diagnostic" and item.get("v") == 1:
            records.append({key: value for key, value in item.items()
                            if key in FIELDS and (value is None or isinstance(value, (bool, int)))})
    stats = re.findall(r"light_sleep_counts:(\d+)\s+light_sleep_reject_counts:(\d+)", text)
    return {
        "records": records, "latest": records[-1] if records else None,
        "sdk_sleep_count": int(stats[-1][0]) if stats else None,
        "sdk_sleep_reject_count": int(stats[-1][1]) if stats else None,
        "crash_marker_seen": bool(re.search(r"Guru Meditation|Backtrace:|assert failed|Task watchdog got triggered", text)),
    }


def capture(port, seconds):
    link = SerialLink(port)
    data = bytearray()
    started = time.monotonic()
    next_request = 0
    try:
        link.connect()
        if link.fd is None:
            raise OSError("serial_unavailable")
        while time.monotonic() - started < seconds:
            now = time.monotonic()
            if now >= next_request:
                write_all(link.fd, encode_frame({"diagnostic": True}))
                next_request = now + 10
            if select.select([link.fd], [], [], 0.2)[0]:
                chunk = os.read(link.fd, 4096)
                if not chunk:
                    raise OSError("serial_disconnected")
                data.extend(chunk)
    finally:
        link.close()
    return bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--seconds", type=int, default=15, choices=range(1, 61))
    parser.add_argument("--output", type=Path, required=True, help="private output directory")
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True)
    try:
        raw = capture(args.port, args.seconds)
    except (OSError, ValueError) as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1
    summary = summarize(raw)
    (args.output / "diagnostics.private.log").write_bytes(raw)
    (args.output / "diagnostics.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    return 0 if summary["latest"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
