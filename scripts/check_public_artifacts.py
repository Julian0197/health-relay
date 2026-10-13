#!/usr/bin/env python3
"""Check tracked/prospective public text without printing credential values."""
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
files = subprocess.check_output(
    ["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=root
).decode().split("\0")
patterns = {
    "personal home path": r"/Users/(?!example/)[A-Za-z0-9._-]+/",
    "tenant document URL": r"https://(?!example\.)[\w-]+\.(?:larkoffice\.com|feishu\.cn)/(?:docx|wiki|base)/[A-Za-z0-9]{15,}",
    "deployed Worker hostname": r"https://[\w-]+\.[\w-]+\.workers\.dev",
    "Cloudflare account binding": r'"account_id"\s*:\s*"[a-fA-F0-9]{32}"',
    "resource identity": r"\b(?:tbl|rec|vew|ou_)(?=[A-Za-z0-9]{10,}\b)(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]+\b",
    "private key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "internal package registry": r"https?://(?:bnpm\.byted\.org|[^/]*npm[^/]*\.bytedance\.net)/",
    "live webhook": r"/open-apis/bot/v2/hook/[a-f0-9]{8}-[a-f0-9-]{27,}",
    "access token": r"\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b",
}
credential_keys = r"(?:HAE_API_KEY|ANALYSIS_API_KEY|FEISHU_SIGN_SECRET|FEISHU_APP_SECRET|SIGNATURE_BASE_TOKEN|DASHBOARD_CACHE_BASE_TOKEN|MAGIC_INIT_CODE|initCode)"
credential_assignments = [
    re.compile(r"\b" + credential_keys + r"[\"']?\s*[:=]\s*(?P<quote>[\"'])(?P<value>[^\"']+)(?P=quote)"),
    re.compile(r"^\s*(?:export\s+)?" + credential_keys + r"=(?P<value>[^\s\"'#;]+)\s*(?:#.*)?$"),
]
synthetic_values = {"secret", "base", "readonly", "readonly-fixture", "__UNBAKED_MAGIC_INIT__"}


def is_synthetic(value):
    return value in synthetic_values or bool(re.match(r"^(?:fixture|test|synthetic|example)(?:[-_]|$)", value))


failures = []
for name in sorted(set(files)):
    if not name:
        continue
    path = root / name
    if not path.is_file():
        continue
    private_name = path.name.endswith((".deploy.html", ".release.html", ".payload.json")) or (
        (path.name == ".env" or path.name.startswith((".env.", ".dev.vars")))
        and not path.name.endswith((".example", ".sample", ".template")))
    if private_name or any(part in {"private-data", "private-artifacts", ".wrangler", "node_modules"} for part in path.parts):
        failures.append((name, 0, "private artifact included"))
        continue
    try:
        content = path.read_text()
    except (UnicodeDecodeError, OSError):
        continue
    for number, line in enumerate(content.splitlines(), 1):
        if any(not is_synthetic(match.group("value"))
               for pattern in credential_assignments for match in pattern.finditer(line)):
            failures.append((name, number, "credential assignment"))
        for label, pattern in patterns.items():
            for match in re.finditer(pattern, line):
                if label == "resource identity" and any(word in match.group().lower() for word in ("example", "synthetic", "fixture", "test", "0123456789", "1234567890")):
                    continue
                failures.append((name, number, label))
for name, number, label in failures:
    print(f"{name}:{number}: {label}")
if failures:
    raise SystemExit(1)
print(f"Public artifact scan passed ({len(set(files)) - 1} files; pattern scan, not a substitute for review).")
