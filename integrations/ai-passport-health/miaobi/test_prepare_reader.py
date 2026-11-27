import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_reader", Path(__file__).with_name("prepare_reader.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
CONFIG = {"base": "fixture_base", "table": "fixture_table", "record": "fixture_record"}


class PrepareReaderTests(unittest.TestCase):
    def test_fixes_coordinates_without_accepting_request_supplied_targets(self):
        source = reader.render(CONFIG)
        for key in CONFIG:
            self.assertIn(json.dumps(CONFIG[key]), source)
            self.assertNotIn("'example_" + key + "'", source)
        self.assertIn("base_records_get(BASE, TABLE, [RECORD])", source)

    def test_rejects_missing_extra_and_code_injection(self):
        for config in ({}, {**CONFIG, "token": "fixture"}, {**CONFIG, "base": "x'; process.exit()"}):
            with self.assertRaises(ValueError):
                reader.render(config)

    def test_private_output_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            output = Path(directory) / "reader.cjs"
            config.write_text(json.dumps(CONFIG)); config.chmod(0o600)
            args = ["--config", str(config), "--output", str(output)]
            self.assertEqual(reader.main(args), 0)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            original = output.read_text()
            self.assertEqual(reader.main(args), 1)
            self.assertEqual(output.read_text(), original)
            output.unlink(); config.chmod(0o644)
            self.assertEqual(reader.main(args), 1)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
