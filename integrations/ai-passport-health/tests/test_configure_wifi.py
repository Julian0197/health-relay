import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import sys
import tempfile
import threading
import tty
import unittest


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("configure_wifi", TOOLS / "configure_wifi.py")
configure_wifi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure_wifi)

CONFIG = {"url": "https://badge.example.test/badge", "token": "synthetic-test-token-0123456789"}


class ConfigureWifiTests(unittest.TestCase):
    def test_miaobi_function_route_requires_the_fixed_https_origin(self):
        accepted = [
            "https://health.example.com:8443/badge",
            "https://magic.solutionsuite.cn/api/faas/example_badge",
            "https://magic.solutionsuite.cn:443/api/faas/health-badge_2",
        ]
        for url in accepted:
            with self.subTest(url=url):
                config = {**CONFIG, "url": url}
                self.assertEqual(configure_wifi.validate_config(config), config)
        rejected = [
            "http://magic.solutionsuite.cn/api/faas/health",
            "HTTPS://magic.solutionsuite.cn/api/faas/health",
            "https://other.example.com/api/faas/health",
            "https://magic.solutionsuite.cn.evil.example/api/faas/health",
            "https://user@magic.solutionsuite.cn/api/faas/health",
            "https://magic.solutionsuite.cn:444/api/faas/health",
            "https://magic.solutionsuite.cn/api/faas/",
            "https://magic.solutionsuite.cn/api/faas/health/more",
            "https://magic.solutionsuite.cn/api/faas/health?key=value",
            "https://magic.solutionsuite.cn/api/faas/health?",
            "https://magic.solutionsuite.cn/api/faas/health#fragment",
            "https://magic.solutionsuite.cn/api/faas/health#",
            "https://magic.solutionsuite.cn/api/faas/%68ealth",
            "https://magic.solutionsuite.cn/api/faas/../health",
            "https://magic.solutionsuite.cn/api/faas/health.badge",
            "https://magic.solutionsuite.cn/api/other/health",
            "https://Magic.solutionsuite.cn/api/faas/health",
            "https://magic.solutionsuite.cn/api/faas/he\nalth",
        ]
        for url in rejected:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    configure_wifi.validate_config({**CONFIG, "url": url})

    def test_only_https_badge_endpoint_and_bounded_printable_token_are_accepted(self):
        self.assertEqual(configure_wifi.validate_config(CONFIG), CONFIG)
        invalid = [
            {**CONFIG, "url": "http://badge.example.test/badge"},
            {**CONFIG, "url": "https://owner:password@badge.example.test/badge"},
            {**CONFIG, "url": "https://badge.example.test/dashboard"},
            {**CONFIG, "url": "https://badge.example.test/badge?token=private"},
            {**CONFIG, "url": "https://badge.example.test/badge?"},
            {**CONFIG, "url": "https://badge.example.test/badge#private"},
            {**CONFIG, "url": "https://badge.example.test/badge#"},
            {**CONFIG, "url": "https://badge.example.test:0/badge"},
            {**CONFIG, "url": "https://badge.example.test:99999/badge"},
            {**CONFIG, "url": "https://bad host.test/badge"},
            {**CONFIG, "url": "https://例子.test/badge"},
            {**CONFIG, "token": "short"},
            {**CONFIG, "token": "x" * 129},
            {**CONFIG, "token": "x" * 16 + "\n"},
            {**CONFIG, "token": "x" * 16 + " "},
            {**CONFIG, "token": "x" * 16 + '"'},
            {**CONFIG, "token": "x" * 16 + "\\"},
            {**CONFIG, "password": "not-part-of-bootstrap"},
        ]
        for config in invalid:
            with self.subTest(config_keys=list(config)):
                with self.assertRaises(ValueError):
                    configure_wifi.validate_config(config)

    def test_private_config_file_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(CONFIG))
            path.chmod(0o600)
            self.assertEqual(configure_wifi.load_config(path), CONFIG)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                configure_wifi.load_config(path)

    def test_provisioning_uses_real_serial_frame_and_waits_for_persistent_ack(self):
        master, slave = os.openpty()
        received = []
        errors = []

        def badge():
            try:
                frame = bytearray()
                while b"\n" not in frame:
                    if not select.select([master], [], [], 2)[0]:
                        raise TimeoutError("configuration frame not received")
                    frame.extend(os.read(master, 4096))
                received.append(json.loads(frame))
                os.write(master, b"I (100) boot: harmless startup log\r\n{\"event\":\"config")
                os.write(master, b"ured\",\"ok\":true}\n")
            except Exception as error:
                errors.append(error)

        thread = threading.Thread(target=badge)
        thread.start()
        try:
            configure_wifi.provision(CONFIG, os.ttyname(slave), timeout=3)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(received, [{"configure": CONFIG}])
        finally:
            os.close(master)
            os.close(slave)
            thread.join(3)

    def test_rejected_ack_does_not_report_success(self):
        master, slave = os.openpty()
        try:
            os.write(master, b'{"event":"configured","ok":false}\n')
            with self.assertRaises(ValueError):
                configure_wifi.wait_for_ack(slave, timeout=0.1)
        finally:
            os.close(master)
            os.close(slave)

    def test_old_success_ack_cannot_mask_rejected_new_configuration(self):
        master, slave = os.openpty()
        tty.setraw(slave)
        os.write(master, b'{"event":"configured","ok":true}\n')
        received = []

        def badge():
            if select.select([master], [], [], 2)[0]:
                received.append(os.read(master, 4096))
                os.write(master, b'{"event":"configured","ok":false}\n')

        thread = threading.Thread(target=badge)
        thread.start()
        try:
            with self.assertRaises(ValueError):
                configure_wifi.provision(CONFIG, os.ttyname(slave), timeout=1)
            thread.join(2)
            self.assertEqual(len(received), 1)
        finally:
            thread.join(2)
            os.close(master)
            os.close(slave)

    def test_no_ack_times_out(self):
        master, slave = os.openpty()
        try:
            with self.assertRaises(TimeoutError):
                configure_wifi.wait_for_ack(slave, timeout=0.02)
        finally:
            os.close(master)
            os.close(slave)

    def test_bad_config_never_echoes_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({**CONFIG, "url": "http://private.invalid/badge"}))
            path.chmod(0o600)
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                self.assertEqual(configure_wifi.main(["--config", str(path), "--port", "/dev/not-a-device"]), 1)
            self.assertNotIn(CONFIG["token"], output.getvalue())
            self.assertNotIn("private.invalid", output.getvalue())


if __name__ == "__main__":
    unittest.main()
