#!/usr/bin/env python3
"""Reduce a private dashboard to an in-memory, bounded USB display snapshot.

Offline: --input dto.json --output badge.json, or --demo --output badge.json.
Live HTTPS: HEALTH_DASHBOARD_URL and HEALTH_ANALYSIS_API_KEY, optionally --port.
Published Base cache: --lark-base TOKEN --lark-table TABLE --lark-record RECORD.
Only the offline commands write health content to a user-selected output file.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
import glob
import hashlib
import json
import math
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import termios
import threading
import time
import urllib.parse
import urllib.request


BEIJING = timezone(timedelta(hours=8))
FRAME_LIMIT = 4096
HTTP_LIMIT = 8 * 1024 * 1024
SEND_INTERVAL_MS = 15000
STATUS_INTERVAL_MS = 60000


def number(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if minimum <= value <= maximum and math.isfinite(value) else None


def metric(value, minimum, maximum):
    value = number(value, minimum, maximum)
    return math.floor(value + 0.5) if value is not None else None


def timestamp(value):
    # A finite, plausible epoch prevents overflows in datetime on malformed input.
    return number(value, 0, 253402214399999)


def clock_ms():
    return int(time.time() * 1000)


def local_day(now_ms):
    return datetime.fromtimestamp(now_ms / 1000, BEIJING).date()


def time_label(value):
    value = timestamp(value)
    return datetime.fromtimestamp(value / 1000, BEIJING).strftime("%m/%d %H:%M") if value is not None else ""


def mapping(value):
    return value if isinstance(value, dict) else {}


def rows(value):
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def date_label(value):
    if not isinstance(value, str):
        return ""
    try:
        parsed = date.fromisoformat(value)
        return value if parsed.isoformat() == value else ""
    except ValueError:
        return ""


def project_dashboard(dto, now_ms, online=True, demo=False):
    """Project only display fields; receipt/render timestamps never become evidence."""
    dto = mapping(dto)
    indices = mapping(dto.get("healthIndices"))
    pressure = mapping(indices.get("pressure"))
    sleep = mapping(indices.get("sleep"))
    heart = mapping(mapping(dto.get("heart")).get("latest"))
    method = pressure.get("hrvMethod", "SDNN")
    valid_method = method in ("RMSSD", "SDNN")
    method = method if valid_method else "SDNN"
    hrv_rows = rows(dto.get("recoveryHrv" if method == "RMSSD" else "hrv")) if valid_method else []
    hrv_rows = [row for row in hrv_rows if timestamp(row.get("t")) is not None and
                row["t"] <= now_ms and number(row.get("v"), 1, 1000) is not None]
    latest_hrv = max(hrv_rows, key=lambda row: row["t"], default={})
    sleep_date = date_label(sleep.get("date"))
    sleep_rows = [row for row in rows(dto.get("sleep")) if sleep_date and row.get("date") == sleep_date]
    sleep_row = max(sleep_rows, key=lambda row: timestamp(row.get("end")) or 0, default={})
    history = {row.get("date"): row for row in rows(mapping(dto.get("pressureHistory")).get("days"))
               if date_label(row.get("date"))}
    today = local_day(now_ms)
    trend = []
    for offset in range(6, -1, -1):
        row = history.get((today - timedelta(days=offset)).isoformat(), {})
        trend.append(metric(row.get("median"), 0, 100) if row.get("status") == "available" else None)
    score = metric(pressure.get("score"), 0, 100)
    expires = timestamp(pressure.get("validUntil"))
    retained = score is not None and (pressure.get("retained") is True or
                                     (expires is not None and now_ms >= expires))
    heart_value = metric(heart.get("v"), 1, 300)
    hrv_value = metric(latest_hrv.get("v"), 1, 1000)
    sleep_score = metric(sleep.get("score"), 0, 100)
    sleep_minutes = metric(sleep_row.get("asleepMinutes"), 0, 1440)
    has_sleep = sleep_score is not None or sleep_minutes is not None
    measurements = [timestamp(pressure.get("evidenceAt")) if score is not None else None,
                    timestamp(heart.get("s")) if heart_value is not None else None,
                    timestamp(latest_hrv.get("t")) if hrv_value is not None else None,
                    timestamp(sleep.get("endAt")) if has_sleep else None,
                    timestamp(sleep_row.get("end")) if has_sleep else None]
    measurements = [value for value in measurements if value is not None and value <= now_ms]
    return {
        "v": 1, "online": bool(online), "demo": bool(demo),
        "asOf": time_label(max(measurements)) if measurements else "",
        "pressure": score, "retained": retained,
        "pressureAt": time_label(pressure.get("evidenceAt")) if score is not None else "",
        "heart": heart_value, "heartAt": time_label(heart.get("s")) if heart_value is not None else "",
        "hrv": hrv_value, "hrvMethod": method,
        "hrvAt": time_label(latest_hrv.get("t")) if hrv_value is not None else "",
        "sleepScore": sleep_score, "sleepMinutes": sleep_minutes,
        "sleepDate": sleep_date, "trend": trend,
    }


def encode_frame(payload):
    frame = (json.dumps(payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode("ascii")
    if len(frame) >= FRAME_LIMIT:
        raise ValueError("frame_too_large")
    return frame


def reject_constant(value):
    raise ValueError("nonfinite_json")


def read_json(value):
    dto = json.loads(value, parse_constant=reject_constant)
    if not isinstance(dto, dict):
        raise ValueError("invalid_document")
    return dto


def endpoint_urls(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or
            parsed.password is not None or parsed.fragment):
        raise ValueError("invalid_https_endpoint")
    try:
        parsed.port
    except ValueError:
        raise ValueError("invalid_https_endpoint") from None
    path = parsed.path.rstrip("/")
    if path and not path.endswith("/dashboard"):
        raise ValueError("invalid_dashboard_path")
    prefix = path[:-len("/dashboard")] if path else ""
    root = urllib.parse.urlunsplit(("https", parsed.netloc, prefix, "", ""))
    return root + "/status", root + "/dashboard?range=7d"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ApiSource:
    def __init__(self, url, key):
        self.status_url, self.dashboard_url = endpoint_urls(url)
        if not key or "\r" in key or "\n" in key:
            raise ValueError("invalid_api_key")
        self.key = key
        self.opener = urllib.request.build_opener(NoRedirect())

    def fetch(self, url):
        request = urllib.request.Request(url, headers={"X-API-Key": self.key, "Accept": "application/json"})
        with self.opener.open(request, timeout=15) as response:
            body = response.read(HTTP_LIMIT + 1)
        if len(body) > HTTP_LIMIT:
            raise ValueError("response_too_large")
        return read_json(body)

    def status(self):
        return self.fetch(self.status_url)

    def dashboard(self):
        return self.fetch(self.dashboard_url)


class LocalCacheSource:
    """Read the existing published Base snapshot using the user's CLI session."""
    poll_interval_ms = 120000

    def __init__(self, base, table, record):
        self.base, self.table, self.record = base, table, record
        self.cached = None

    def status(self):
        with tempfile.TemporaryDirectory(prefix="health-badge-") as directory:
            output = Path(directory) / "record.ndjson"
            command = ["lark-cli", "base", "+record-get", "--base-token", self.base,
                       "--table-id", self.table, "--record-id", self.record,
                       "--field-id", "payload_7d", "--format", "ndjson", "--output", output.name, "--as", "user"]
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                    timeout=45, check=False, cwd=directory)
            if result.returncode != 0:
                raise RuntimeError("cache_cli_failed")
            summary = read_json(result.stdout)
            record_file = summary.get("record_file") or mapping(summary.get("data")).get("record_file")
            record_path = Path(record_file) if isinstance(record_file, str) else output
            if not record_path.is_absolute():
                record_path = Path(directory) / record_path
            if record_path.resolve().parent != Path(directory).resolve():
                raise ValueError("invalid_cache_path")
            os.chmod(str(record_path), 0o600)
            if record_path.stat().st_size > HTTP_LIMIT:
                raise ValueError("cache_too_large")
            records = [read_json(line) for line in record_path.read_text().splitlines() if line.strip()]
            if len(records) != 1 or not isinstance(records[0].get("payload_7d"), str):
                raise ValueError("invalid_cache_record")
            self.cached = read_json(records[0]["payload_7d"])
        revision = self.cached.get("contentHash")
        if not isinstance(revision, str):
            revision = hashlib.sha256(json.dumps(self.cached, sort_keys=True, allow_nan=False).encode()).hexdigest()
        return {"dashboardCache": {"revision": revision}, "lastReceivedAt": self.cached.get("dataUpdatedAt")}

    def dashboard(self):
        if self.cached is None:
            raise ValueError("missing_cache")
        return self.cached


def status_fingerprint(status):
    cache, signature = mapping(status.get("dashboardCache")), mapping(status.get("signature"))
    selected = {"revision": cache.get("revision"), "lastPublishedAt": cache.get("lastPublishedAt"),
                "lastReceivedAt": status.get("lastReceivedAt"), "lastSentAt": signature.get("lastSentAt"),
                "dataTimes": status.get("dataTimes")}
    return json.dumps(selected, sort_keys=True, allow_nan=False, separators=(",", ":"))


def report_error(error):
    # Exception messages, CLI output and URLs may contain private information.
    print("health_bridge: " + type(error).__name__, file=sys.stderr)


class LiveBridge:
    def __init__(self, source, report_error=report_error):
        self.source, self.report_error = source, report_error
        self.cached = {}
        self.online = False
        self.fingerprint = None
        self.fetched_fingerprint = None
        self.last_status = None
        self.last_attempt = None
        self.retry_at = 0
        self.dashboard_day = None
        self.expiry = None
        self.has_dashboard = False

    def tick(self, now_ms, manual=False):
        allowed = self.last_attempt is None or now_ms - self.last_attempt >= SEND_INTERVAL_MS
        manual = manual and allowed
        interval = getattr(self.source, "poll_interval_ms", STATUS_INTERVAL_MS)
        status_due = self.last_status is None or now_ms - self.last_status >= interval
        status_ok = self.online
        if status_due or manual:
            self.last_status = now_ms
            try:
                self.fingerprint = status_fingerprint(self.source.status())
                status_ok = True
                self.online = self.has_dashboard
            except Exception as error:
                self.online, status_ok = False, False
                self.report_error(error)
        due = (not self.has_dashboard or self.fingerprint != self.fetched_fingerprint or
               self.dashboard_day != local_day(now_ms) or (self.expiry is not None and now_ms >= self.expiry))
        if status_ok and allowed and (manual or (due and now_ms >= self.retry_at)):
            self.last_attempt = now_ms
            try:
                dto = self.source.dashboard()
                if not isinstance(dto, dict):
                    raise ValueError("invalid_dashboard")
                self.cached, self.has_dashboard, self.online = dto, True, True
                self.fetched_fingerprint = self.fingerprint
                self.dashboard_day = local_day(now_ms)
                indices = mapping(dto.get("healthIndices"))
                expiries = [timestamp(indices.get("validUntil")),
                            timestamp(mapping(indices.get("pressure")).get("validUntil"))]
                self.expiry = min((value for value in expiries if value is not None and value > now_ms), default=None)
                self.retry_at = 0
            except Exception as error:
                self.online = False
                self.retry_at = now_ms + interval
                self.report_error(error)
        return project_dashboard(self.cached, now_ms, online=self.online)


class SourceWorker:
    """Keep source latency out of the USB receive and 15-second keepalive loop."""
    def __init__(self, source):
        self.live = LiveBridge(source)
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.manual = threading.Event()
        self.cached, self.online = {}, False
        self.thread = threading.Thread(target=self.run, name="health-source")

    def start(self):
        self.thread.start()

    def run(self):
        while not self.stopped.is_set():
            manual = self.manual.is_set()
            self.manual.clear()
            self.live.tick(clock_ms(), manual=manual)
            with self.lock:
                self.cached, self.online = self.live.cached, self.live.online
            self.stopped.wait(0.2)

    def refresh(self):
        self.manual.set()

    def snapshot(self, now):
        with self.lock:
            cached, online = self.cached, self.online
        return project_dashboard(cached, now, online=online)

    def close(self):
        self.stopped.set()
        if self.thread.is_alive():
            self.thread.join()  # Allow a pending CLI read to remove its private files.


def write_all(fd, frame, timeout=3):
    remaining = memoryview(frame)
    deadline = time.monotonic() + timeout
    while remaining:
        wait = deadline - time.monotonic()
        if wait <= 0:
            raise TimeoutError("serial_write_timeout")
        if not select.select([], [fd], [], wait)[1]:
            raise TimeoutError("serial_write_timeout")
        try:
            written = os.write(fd, remaining)
        except BlockingIOError:
            continue
        if written <= 0:
            raise OSError("serial_write_failed")
        remaining = remaining[written:]


class RefreshReader:
    def __init__(self):
        self.buffer = bytearray()
        self.discarding = False

    def feed(self, data):
        refresh = False
        for value in data:
            if value == 10:
                if not self.discarding:
                    try:
                        event = json.loads(self.buffer)
                        refresh = refresh or (isinstance(event, dict) and event.get("event") == "refresh")
                    except (ValueError, UnicodeDecodeError):
                        pass
                self.buffer.clear()
                self.discarding = False
            elif not self.discarding:
                self.buffer.append(value)
                if len(self.buffer) >= FRAME_LIMIT:
                    self.buffer.clear()
                    self.discarding = True
        return refresh


class SerialLink:
    def __init__(self, port=None):
        self.port, self.fd = port, None
        self.reader = RefreshReader()
        self.reconnect_at = 0

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.reader = RefreshReader()

    def connect(self):
        if self.fd is not None or time.monotonic() < self.reconnect_at:
            return
        self.reconnect_at = time.monotonic() + 3
        ports = [self.port] if self.port else sorted(set(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.usbserial*")))
        if len(ports) != 1:
            return
        fd = os.open(ports[0], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            attrs = termios.tcgetattr(fd)
            attrs[0] = 0
            attrs[1] = 0
            attrs[2] = (attrs[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB | termios.HUPCL)) | termios.CS8 | termios.CLOCAL | termios.CREAD
            attrs[3] = 0
            attrs[4] = attrs[5] = termios.B115200
            attrs[6][termios.VMIN] = 0
            attrs[6][termios.VTIME] = 0
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
        except Exception:
            os.close(fd)
            raise
        # Never issue DTR/RTS ioctls or an ESP reset sequence.
        self.fd = fd

    def refresh_requested(self):
        if self.fd is None or not select.select([self.fd], [], [], 0)[0]:
            return False
        data = os.read(self.fd, FRAME_LIMIT)
        if not data:
            raise OSError("serial_disconnected")
        return self.reader.feed(data)

    def send(self, payload):
        if self.fd is not None:
            write_all(self.fd, encode_frame(payload))


def run_live(source, port=None):
    worker, serial = SourceWorker(source), SerialLink(port)
    next_send = 0
    worker.start()
    try:
        while True:
            manual = False
            try:
                was_connected = serial.fd is not None
                serial.connect()
                if not was_connected and serial.fd is not None:
                    next_send = 0
                manual = serial.refresh_requested()
            except (OSError, termios.error) as error:
                report_error(error)
                serial.close()
            now = clock_ms()
            if manual:
                worker.refresh()
            payload = worker.snapshot(now)
            if now >= next_send or manual:
                try:
                    serial.send(payload)
                except (OSError, TimeoutError) as error:
                    report_error(error)
                    serial.close()
                next_send = now + SEND_INTERVAL_MS
            time.sleep(0.1)
    finally:
        serial.close()
        worker.close()


def demo_dashboard(now):
    """Explicitly synthetic: never derived from local or remote health records."""
    today = local_day(now)
    return {"dataUpdatedAt": now - 60000,
            "healthIndices": {"pressure": {"score": 36, "evidenceAt": now - 1800000,
                                             "validUntil": now + 3600000, "hrvMethod": "RMSSD"},
                              "sleep": {"score": 85, "date": today.isoformat()}},
            "heart": {"latest": {"s": now - 60000, "v": 72}},
            "recoveryHrv": [{"t": now - 1800000, "v": 41}],
            "sleep": [{"date": today.isoformat(), "asleepMinutes": 423}],
            "pressureHistory": {"days": [{"date": (today - timedelta(days=6 - index)).isoformat(),
                                             "status": "available", "median": score}
                                            for index, score in enumerate([42, 38, 51, 40, 32, 36, 36])]}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--input", type=Path, help="saved dashboard DTO (offline)")
    modes.add_argument("--demo", action="store_true", help="synthetic preview (offline)")
    modes.add_argument("--lark-base", help="published Base cache token (user CLI session)")
    parser.add_argument("--lark-table")
    parser.add_argument("--lark-record")
    parser.add_argument("--output", type=Path, help="offline snapshot destination")
    parser.add_argument("--port", help="explicit POSIX serial port; otherwise detect one USB candidate")
    args = parser.parse_args(argv)
    try:
        if args.demo or args.input:
            now = clock_ms()
            dto = demo_dashboard(now) if args.demo else read_json(args.input.read_bytes())
            frame = encode_frame(project_dashboard(dto, now, online=True, demo=args.demo))
            if args.output:
                descriptor = os.open(str(args.output), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(descriptor, "wb") as output:
                    os.fchmod(output.fileno(), 0o600)
                    output.write(frame)
            else:
                sys.stdout.buffer.write(frame)
            return 0
        if args.output:
            raise ValueError("output_requires_offline_mode")
        if args.lark_base:
            if not args.lark_table or not args.lark_record:
                raise ValueError("missing_cache_identifiers")
            source = LocalCacheSource(args.lark_base, args.lark_table, args.lark_record)
        else:
            if args.lark_table or args.lark_record:
                raise ValueError("missing_cache_base")
            source = ApiSource(os.environ.get("HEALTH_DASHBOARD_URL", ""), os.environ.get("HEALTH_ANALYSIS_API_KEY", ""))
        run_live(source, args.port)
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        report_error(error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
