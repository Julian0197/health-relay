"""Synthetic fixtures only: no credentials, personal records, or device access."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("health_bridge", ROOT / "tools/health_bridge.py")
bridge = importlib.util.module_from_spec(SPEC) if SPEC else None
if SPEC and SPEC.loader and (ROOT / "tools/health_bridge.py").exists():
    SPEC.loader.exec_module(bridge)

NOW = 1792576800000  # 2026-10-21 18:00 Asia/Shanghai.


def fixture():
    return {
        "generatedAt": NOW, "dataUpdatedAt": NOW - 60000,
        "healthIndices": {
            "validUntil": NOW + 3600000,
            "pressure": {"score": 36, "evidenceAt": NOW - 1800000,
                         "validUntil": NOW + 3600000, "hrvMethod": "RMSSD", "retained": False},
            "sleep": {"score": 85, "date": "2026-10-21", "endAt": NOW - 36000000},
        },
        "heart": {"latest": {"s": NOW - 60000, "e": NOW, "v": 72},
                  "points": [{"s": NOW, "v": 200}]},
        "recoveryHrv": [{"t": NOW - 1800000, "v": 41}, {"t": NOW - 3600000, "v": 40}],
        "hrv": [{"t": NOW - 1000, "v": 99}],
        "sleep": [{"date": "2026-10-21", "asleepMinutes": 423, "end": NOW - 36000000},
                  {"date": "2026-10-20", "asleepMinutes": 500, "score": 95, "end": NOW}],
        "pressureHistory": {"days": [
            {"date": "2026-10-15", "status": "available", "median": 42},
            {"date": "2026-10-17", "status": "insufficient_samples", "median": 90},
            {"date": "2026-10-19", "status": "available", "median": 32},
            {"date": "2026-10-21", "status": "available", "median": 36},
        ]},
        "source": "must-not-be-transmitted", "raw": {"private": True},
    }


class ProjectionTests(unittest.TestCase):
    def test_projects_authoritative_fields_and_independent_measurement_times(self):
        result = bridge.project_dashboard(fixture(), NOW)
        self.assertEqual((result["pressure"], result["heart"], result["hrv"]), (36, 72, 41))
        self.assertEqual((result["pressureAt"], result["heartAt"], result["hrvAt"]),
                         ("10/21 17:30", "10/21 17:59", "10/21 17:30"))
        self.assertEqual(result["asOf"], "10/21 17:59")
        self.assertEqual(result["sleepScore"], 85)
        self.assertEqual(result["sleepMinutes"], 423)
        self.assertEqual(result["sleepDate"], "2026-10-21")
        self.assertEqual(result["trend"], [42, None, None, None, 32, None, 36])
        self.assertFalse(result["demo"])
        self.assertTrue(result["online"])
        self.assertNotIn("source", result)
        self.assertNotIn("raw", result)

    def test_missing_values_stay_null_and_generated_at_is_not_measurement_time(self):
        result = bridge.project_dashboard({"generatedAt": NOW}, NOW)
        for key in ("pressure", "heart", "hrv", "sleepScore", "sleepMinutes"):
            self.assertIsNone(result[key])
        self.assertEqual(result["asOf"], "")
        self.assertEqual(result["trend"], [None] * 7)

    def test_wire_metrics_round_halves_up_and_keep_measurement_timestamps(self):
        dto = fixture()
        dto["healthIndices"]["pressure"]["score"] = 36.5
        dto["heart"]["latest"]["v"] = 72.5
        dto["recoveryHrv"][0]["v"] = 41.5
        dto["healthIndices"]["sleep"]["score"] = 85.5
        dto["sleep"][0]["asleepMinutes"] = 423.5
        dto["pressureHistory"]["days"][0]["median"] = 42.5
        result = bridge.project_dashboard(dto, NOW)
        self.assertEqual([result[key] for key in ("pressure", "heart", "hrv", "sleepScore", "sleepMinutes")],
                         [37, 73, 42, 86, 424])
        self.assertEqual(result["trend"][0], 43)
        self.assertEqual(result["heartAt"], "10/21 17:59")

    def test_asof_ignores_unshown_workout_or_step_update_time(self):
        dto = fixture()
        dto["dataUpdatedAt"] = NOW
        self.assertEqual(bridge.project_dashboard(dto, NOW)["asOf"], "10/21 17:59")

    def test_rejects_bool_nonfinite_and_out_of_range_metrics(self):
        for value in (True, False, float("nan"), float("inf"), -1, 101, 10 ** 1000):
            dto = fixture()
            dto["healthIndices"]["pressure"]["score"] = value
            self.assertIsNone(bridge.project_dashboard(dto, NOW)["pressure"])
        dto = fixture()
        dto["heart"]["latest"]["v"] = 301
        dto["recoveryHrv"][0]["v"] = True
        dto["recoveryHrv"][1]["v"] = 0
        dto["healthIndices"]["sleep"]["score"] = float("inf")
        dto["sleep"][0]["asleepMinutes"] = 1441
        result = bridge.project_dashboard(dto, NOW)
        for key in ("heart", "hrv", "sleepScore", "sleepMinutes"):
            self.assertIsNone(result[key])

    def test_zero_is_valid_for_scores_but_not_heart_or_hrv(self):
        dto = fixture()
        dto["healthIndices"]["pressure"]["score"] = 0
        dto["healthIndices"]["sleep"]["score"] = 0
        dto["heart"]["latest"]["v"] = 0
        result = bridge.project_dashboard(dto, NOW)
        self.assertEqual(result["pressure"], 0)
        self.assertEqual(result["sleepScore"], 0)
        self.assertIsNone(result["heart"])

    def test_retained_and_expired_pressure_remain_marked(self):
        for fields in ({"retained": True}, {"validUntil": NOW - 1}):
            dto = fixture()
            dto["healthIndices"]["pressure"].update(fields)
            result = bridge.project_dashboard(dto, NOW)
            self.assertEqual(result["pressure"], 36)
            self.assertTrue(result["retained"])

    def test_sdnn_never_falls_back_to_rmssd_and_vice_versa(self):
        dto = fixture()
        dto["healthIndices"]["pressure"]["hrvMethod"] = "SDNN"
        self.assertEqual(bridge.project_dashboard(dto, NOW)["hrv"], 99)
        dto["hrv"] = []
        self.assertIsNone(bridge.project_dashboard(dto, NOW)["hrv"])
        dto["healthIndices"]["pressure"]["hrvMethod"] = "RMSSD"
        dto["recoveryHrv"] = []
        self.assertIsNone(bridge.project_dashboard(dto, NOW)["hrv"])

    def test_sleep_never_substitutes_historical_score_or_other_night(self):
        dto = fixture()
        dto["healthIndices"]["sleep"] = {"score": None, "date": "2026-10-22"}
        result = bridge.project_dashboard(dto, NOW)
        self.assertIsNone(result["sleepScore"])
        self.assertIsNone(result["sleepMinutes"])
        self.assertEqual(result["sleepDate"], "2026-10-22")

    def test_trend_uses_beijing_day_with_fixed_gaps(self):
        midnight = NOW + 6 * 3600000
        result = bridge.project_dashboard(fixture(), midnight)
        self.assertEqual(result["trend"], [None, None, None, 32, None, 36, None])

    def test_frame_is_ascii_bounded_flat_and_roundtrips_null(self):
        result = bridge.project_dashboard(fixture(), NOW)
        frame = bridge.encode_frame(result)
        self.assertLess(len(frame), 4096)
        self.assertTrue(frame.endswith(b"\n"))
        frame.decode("ascii")
        self.assertEqual(json.loads(frame), result)
        with self.assertRaises(ValueError):
            bridge.encode_frame({"bad": float("nan")})
        with self.assertRaises(ValueError):
            bridge.encode_frame({"bad": "x" * 4096})


class FakeApi:
    def __init__(self):
        self.status_calls = 0
        self.dashboard_calls = 0
        self.status_value = {"lastReceivedAt": 1, "dashboardCache": {"revision": 1, "lastPublishedAt": 1},
                             "signature": {"lastSentAt": 1}}
        self.dto = fixture()
        self.fail = False

    def status(self):
        self.status_calls += 1
        if self.fail:
            raise OSError("private failure detail")
        return copy.deepcopy(self.status_value)

    def dashboard(self):
        self.dashboard_calls += 1
        return copy.deepcopy(self.dto)


class PollTests(unittest.TestCase):
    def test_unchanged_status_does_not_rescan_dashboard(self):
        api = FakeApi()
        live = bridge.LiveBridge(api, report_error=lambda error: None)
        live.tick(NOW)
        for seconds in range(15, 301, 15):
            api.status_value["sqlReadUsage"] = {"reads": seconds}
            live.tick(NOW + seconds * 1000)
        self.assertEqual(api.status_calls, 6)
        self.assertEqual(api.dashboard_calls, 1)

    def test_status_revision_publication_and_receipt_changes_refresh_dashboard(self):
        for section, key in (("dashboardCache", "revision"), ("dashboardCache", "lastPublishedAt"),
                             ("signature", "lastSentAt"), (None, "lastReceivedAt")):
            api = FakeApi()
            live = bridge.LiveBridge(api, report_error=lambda error: None)
            live.tick(NOW)
            target = api.status_value if section is None else api.status_value[section]
            target[key] = 2
            live.tick(NOW + 60000)
            self.assertEqual(api.dashboard_calls, 2)

    def test_expiry_and_midnight_refresh_once(self):
        api = FakeApi()
        api.dto["healthIndices"]["validUntil"] = NOW + 30000
        api.dto["healthIndices"]["pressure"]["validUntil"] = NOW + 30000
        live = bridge.LiveBridge(api, report_error=lambda error: None)
        live.tick(NOW)
        self.assertTrue(live.tick(NOW + 30000)["retained"])
        live.tick(NOW + 45000)
        self.assertEqual(api.dashboard_calls, 2)
        live.tick(NOW + 6 * 3600000)
        live.tick(NOW + 6 * 3600000 + 1000)
        self.assertEqual(api.dashboard_calls, 3)

    def test_manual_refresh_is_limited_to_fifteen_seconds(self):
        api = FakeApi()
        live = bridge.LiveBridge(api, report_error=lambda error: None)
        live.tick(NOW)
        live.tick(NOW + 1000, manual=True)
        self.assertEqual(api.dashboard_calls, 1)
        live.tick(NOW + 15000, manual=True)
        live.tick(NOW + 16000, manual=True)
        self.assertEqual(api.dashboard_calls, 2)

    def test_api_failure_keeps_cached_measurements_and_signals_offline(self):
        api = FakeApi()
        errors = []
        live = bridge.LiveBridge(api, report_error=errors.append)
        live.tick(NOW)
        api.fail = True
        result = live.tick(NOW + 60000)
        self.assertFalse(result["online"])
        self.assertEqual(result["heart"], 72)
        self.assertEqual(api.dashboard_calls, 1)
        self.assertEqual(len(errors), 1)


class TransportTests(unittest.TestCase):
    def test_worker_snapshot_remains_available_while_source_read_blocks(self):
        api = FakeApi()
        entered, release = threading.Event(), threading.Event()
        original_status = api.status

        def status():
            entered.set()
            release.wait(2)
            return original_status()

        api.status = status
        worker = bridge.SourceWorker(api)
        try:
            worker.start()
            self.assertTrue(entered.wait(1))
            result = worker.snapshot(NOW)
            self.assertFalse(result["online"])
            self.assertEqual(result["v"], 1)
        finally:
            release.set()
            worker.close()

    def test_lark_cache_has_a_two_minute_poll_interval(self):
        api = FakeApi()
        api.poll_interval_ms = bridge.LocalCacheSource.poll_interval_ms
        live = bridge.LiveBridge(api, report_error=lambda error: None)
        live.tick(NOW)
        live.tick(NOW + 60000)
        self.assertEqual(api.status_calls, 1)
        live.tick(NOW + 120000)
        self.assertEqual(api.status_calls, 2)

    def test_lark_cache_uses_direct_user_cli_and_deletes_private_temporary_files(self):
        paths = []

        def run(argv, **kwargs):
            self.assertEqual(argv[:3], ["lark-cli", "base", "+record-get"])
            self.assertEqual(argv[-2:], ["--as", "user"])
            self.assertNotIn("shell", kwargs)
            self.assertNotIn("preexec_fn", kwargs)
            self.assertIn("cwd", kwargs)
            directory = Path(kwargs["cwd"])
            relative_output = Path(argv[argv.index("--output") + 1])
            self.assertEqual(relative_output, Path("record.ndjson"))
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            output = directory / relative_output
            self.assertFalse(output.exists())
            paths.append(directory)
            output.write_text(json.dumps({"payload_7d": json.dumps(fixture()), "record_id": "synthetic"}) + "\n")
            (output.parent / "manifest.json").write_text("{}")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"record_file": str(output)}), stderr="")

        source = bridge.LocalCacheSource("synthetic-base", "synthetic-table", "synthetic-record")
        with patch.object(bridge.subprocess, "run", side_effect=run):
            source.status()
        self.assertEqual(source.dashboard()["healthIndices"]["pressure"]["score"], 36)
        self.assertTrue(all(not path.exists() for path in paths))

    def test_lark_cache_error_is_short_and_cannot_leak_cli_output(self):
        source = bridge.LocalCacheSource("base", "table", "record")
        failure = SimpleNamespace(returncode=1, stdout="private health", stderr="private health")
        with patch.object(bridge.subprocess, "run", return_value=failure):
            with self.assertRaises(RuntimeError) as caught:
                source.status()
        self.assertNotIn("private", str(caught.exception))

    def test_https_validation_and_fixed_read_endpoints(self):
        for url in ("http://example.invalid/dashboard", "https://u:p@example.invalid/dashboard",
                    "https:///dashboard", "https://example.invalid/dashboard#secret"):
            with self.assertRaises(ValueError):
                bridge.endpoint_urls(url)
        self.assertEqual(bridge.endpoint_urls("https://example.invalid/dashboard?range=24h"),
                         ("https://example.invalid/status", "https://example.invalid/dashboard?range=7d"))

    def test_redirect_handler_never_forwards_authenticated_request(self):
        import urllib.request
        request = urllib.request.Request("https://example.invalid/dashboard", headers={"X-API-Key": "synthetic"})
        self.assertIsNone(bridge.NoRedirect().redirect_request(request, None, 302, "redirect", {},
                                                              "https://other.invalid/dashboard"))

    def test_write_all_handles_partial_and_temporarily_blocked_writes(self):
        output = bytearray()
        calls = [0]

        def write(fd, data):
            calls[0] += 1
            if calls[0] == 1:
                raise BlockingIOError()
            output.extend(data[:3])
            return min(len(data), 3)

        with patch.object(bridge.os, "write", side_effect=write), patch.object(bridge.select, "select", return_value=([], [7], [])):
            bridge.write_all(7, b'{"v":1}\n')
        self.assertEqual(output, b'{"v":1}\n')

    def test_refresh_decoder_handles_partial_oversize_and_untrusted_input(self):
        reader = bridge.RefreshReader()
        self.assertFalse(reader.feed(b'{"event":'))
        self.assertTrue(reader.feed(b'"refresh"}\n'))
        self.assertFalse(reader.feed(b'x' * 5000))
        self.assertTrue(reader.feed(b'garbage\n{"event":"refresh"}\n'))
        self.assertFalse(reader.feed(b'{"event":"other"}\nnull\n[]\n'))

    def test_cli_demo_has_explicit_demo_flag_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "badge.json"
            result = subprocess.run([sys.executable, str(ROOT / "tools/health_bridge.py"), "--demo", "--output", str(output)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertTrue(json.loads(output.read_text())["demo"])

    def test_cli_offline_projection_uses_private_output_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "dto.json", Path(directory) / "badge.json"
            source.write_text(json.dumps(fixture()))
            result = subprocess.run([sys.executable, str(ROOT / "tools/health_bridge.py"),
                                     "--input", str(source), "--output", str(output)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertFalse(json.loads(output.read_text())["demo"])

    def test_serial_configuration_never_issues_control_line_ioctls(self):
        attrs = [0, 0, bridge.termios.HUPCL, 0, 0, 0, [0] * 32]
        link = bridge.SerialLink("/synthetic/port")
        with patch.object(bridge.os, "open", return_value=7), \
                patch.object(bridge.termios, "tcgetattr", return_value=attrs), \
                patch.object(bridge.termios, "tcsetattr") as configure, \
                patch.object(bridge.os, "close"):
            link.connect()
            configured = configure.call_args[0][2]
            self.assertEqual(configured[4:6], [bridge.termios.B115200] * 2)
            self.assertFalse(configured[2] & bridge.termios.HUPCL)
            self.assertEqual(link.fd, 7)
            link.close()
            self.assertIsNone(link.fd)

    def test_cli_invalid_live_config_never_prints_credentials(self):
        env = dict(os.environ, HEALTH_DASHBOARD_URL="http://private.invalid/secret", HEALTH_ANALYSIS_API_KEY="private-key")
        result = subprocess.run([sys.executable, str(ROOT / "tools/health_bridge.py")], env=env,
                                capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("private", result.stderr)
        self.assertNotIn("private", result.stdout)


if __name__ == "__main__":
    unittest.main()
