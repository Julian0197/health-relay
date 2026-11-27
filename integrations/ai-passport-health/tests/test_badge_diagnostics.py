import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from badge_diagnostics import summarize


class DiagnosticsReaderTest(unittest.TestCase):
    def test_filters_unknown_fields_and_reads_sdk_counters(self):
        raw = (b'{"event":"diagnostic","v":1,"battery_mv":3700,"token":"private","free_heap":"invalid"}\n'
               b'light_sleep_counts:123  light_sleep_reject_counts:4\n')
        summary = summarize(raw)
        self.assertEqual(summary["sdk_sleep_count"], 123)
        self.assertEqual(summary["sdk_sleep_reject_count"], 4)
        self.assertEqual(summary["latest"], {"v": 1, "battery_mv": 3700})
        self.assertNotIn("private", json.dumps(summary))

    def test_silence_or_other_protocol_frames_do_not_prove_diagnostics(self):
        result = summarize(b'{"event":"configured","ok":true}\nnot-json\n')
        self.assertIsNone(result["latest"])
        self.assertIsNone(result["sdk_sleep_count"])


if __name__ == "__main__":
    unittest.main()
