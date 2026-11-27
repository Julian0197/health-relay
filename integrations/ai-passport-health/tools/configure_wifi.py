#!/usr/bin/env python3
"""Provision a badge's HTTPS endpoint from a private file, without echoing it."""
import argparse
import json
import os
from pathlib import Path
import re
import select
import sys
import termios
import time
import urllib.parse

from health_bridge import FRAME_LIMIT, SerialLink, encode_frame, write_all


def validate_config(config):
    if not isinstance(config, dict) or set(config) != {"url", "token"}:
        raise ValueError("invalid_configuration")
    url, token = config["url"], config["token"]
    if (not isinstance(url, str) or not 15 <= len(url) < 256 or not url.startswith("https://") or
            any(not 0x21 <= ord(c) <= 0x7e for c in url) or "?" in url or "#" in url):
        raise ValueError("invalid_endpoint")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or
            parsed.password is not None or
            not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", parsed.netloc)):
        raise ValueError("invalid_endpoint")
    if parsed.port == 0:  # urlsplit rejects ports over 65535.
        raise ValueError("invalid_endpoint")
    miaobi_route = (parsed.netloc.split(":", 1)[0] == "reader.example.com" and
                    parsed.port in (None, 443) and
                    re.fullmatch(r"/api/faas/[A-Za-z0-9_-]+", parsed.path))
    if parsed.path != "/badge" and not miaobi_route:
        raise ValueError("invalid_endpoint")
    if (not isinstance(token, str) or not 16 <= len(token) <= 128 or
            any(not 0x21 <= ord(c) <= 0x7e or c in '\\"' for c in token)):
        raise ValueError("invalid_token")
    return {"url": url, "token": token}


def load_config(path):
    if path.stat().st_mode & 0o077 or path.stat().st_size > FRAME_LIMIT:
        raise ValueError("configuration_file_must_be_private")
    return validate_config(json.loads(path.read_text()))


def wait_for_ack(fd, timeout):
    deadline = time.monotonic() + timeout
    line = bytearray()
    discarding = False
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        data = os.read(fd, FRAME_LIMIT)
        if not data:
            raise OSError("serial_disconnected")
        for byte in data:
            if byte == 10:
                if not discarding:
                    try:
                        event = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        event = None
                    if isinstance(event, dict) and event.get("event") == "configured":
                        if event.get("ok") is True:
                            return
                        raise ValueError("badge_rejected_configuration")
                line.clear()
                discarding = False
            elif not discarding:
                line.append(byte)
                if len(line) >= FRAME_LIMIT:
                    line.clear()
                    discarding = True
    raise TimeoutError("configuration_not_acknowledged")


def provision(config, port, timeout=30):
    config = validate_config(config)
    serial = SerialLink(port)
    try:
        serial.connect()
        if serial.fd is None:
            raise OSError("serial_unavailable")
        termios.tcflush(serial.fd, termios.TCIFLUSH)
        write_all(serial.fd, encode_frame({"configure": config}))
        wait_for_ack(serial.fd, timeout)
    finally:
        serial.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="owner-only JSON file containing url and token")
    parser.add_argument("--port", required=True, help="explicit badge serial path; stop the USB bridge first")
    args = parser.parse_args(argv)
    try:
        provision(load_config(args.config), args.port)
        print("Endpoint saved. Hold OK on the badge to enter Wi-Fi setup.")
        return 0
    except (OSError, ValueError, TimeoutError) as error:
        # Neither exception messages nor received device lines are safe to echo.
        print("configure_wifi: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
