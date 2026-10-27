"""Exercise the public-file boundary using temporary repositories and fake values."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class PublicArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "scripts").mkdir()
        shutil.copyfile(Path(__file__).with_name("check_public_artifacts.py"),
                        self.root / "scripts/check_public_artifacts.py")

    def scan(self):
        return subprocess.run(["python3", "scripts/check_public_artifacts.py"],
                              cwd=self.root, capture_output=True, text=True)

    def test_rejects_credential_assignments_without_printing_values(self):
        value = "NotAnActualCredential9A72"
        for key in ("HAE_API_KEY", "NATIVE_API_KEY", "ANALYSIS_API_KEY", "FEISHU_SIGN_SECRET",
                    "FEISHU_APP_SECRET", "MAGIC_INIT_CODE", "initCode",
                    "SIGNATURE_BASE_TOKEN", "DASHBOARD_CACHE_BASE_TOKEN"):
            for line in (f'{key}={value}', f'"{key}": "{value}"', f"const {key} = '{value}';"):
                with self.subTest(key=key, syntax=line.split(value)[0]):
                    (self.root / "config.txt").write_text(line)
                    result = self.scan()
                    self.assertEqual(result.returncode, 1)
                    self.assertIn("credential assignment", result.stdout)
                    self.assertNotIn(value, result.stdout + result.stderr)

    def test_accepts_empty_and_explicit_synthetic_placeholders(self):
        (self.root / "config.txt").write_text("\n".join([
            'HAE_API_KEY=',
            'FEISHU_SIGN_SECRET="fixture-only"',
            "const MAGIC_INIT_CODE = '__UNBAKED_MAGIC_INIT__';",
            'ANALYSIS_API_KEY="readonly-fixture"',
        ]))
        self.assertEqual(self.scan().returncode, 0)

    def test_rejects_force_tracked_private_output(self):
        (self.root / ".gitignore").write_text("*.deploy.html\n.dev.vars\n")
        for name in ("dashboard.deploy.html", ".dev.vars"):
            (self.root / name).write_text("private")
            subprocess.run(["git", "add", "-f", name], cwd=self.root, check=True)
        result = self.scan()
        self.assertEqual(result.returncode, 1)
        self.assertIn("private artifact included", result.stdout)


if __name__ == "__main__":
    unittest.main()
