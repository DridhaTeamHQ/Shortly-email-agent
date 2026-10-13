"""Import one day's batch from Excel/CSV files -- the same as the dashboard's
"Upload daily batch" button.

New addresses join today's batch and get the welcome email from the
send-welcomes cron; their newsletter starts the day after that email is sent.
Addresses already in the list (including unsubscribed ones) are left alone.

    python scripts/import-daily-batch.py <file-or-folder> [more ...] [--dry-run]

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env (never printed).
--dry-run only parses the files and reports what would be uploaded.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
EMAIL_HEADERS = {"email", "e-mail", "email_id", "emailid", "email_address", "mail_id"}
NAME_HEADERS = {"name", "full_name", "fullname"}


def load_env():
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if m:
            env[m.group(1)] = m.group(2).strip('"').strip("'")
    return env


def norm(header):
    return re.sub(r"\s+", "_", re.sub(r"[^\w\s-]", "", str(header).strip().lower()))


def read_rows(path):
    frame = pd.read_csv(path, dtype=str) if path.suffix.lower() == ".csv" else pd.read_excel(path, dtype=str)
    columns = {norm(c): c for c in frame.columns}
    email_col = next((columns[h] for h in columns if h in EMAIL_HEADERS), None)
    if email_col is None:
        raise RuntimeError(f"{path.name}: no Email column (found {list(frame.columns)})")
    name_col = next((columns[h] for h in columns if h in NAME_HEADERS), None)
    rows = []
    for _, r in frame.iterrows():
        email = str(r[email_col]).strip() if pd.notna(r[email_col]) else ""
        if not email:
            continue
        name = str(r[name_col]).strip() if name_col and pd.notna(r[name_col]) else ""
        rows.append({"email": email, "full_name": name})
    return rows


def collect(paths):
    files = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(f for f in p.iterdir() if f.suffix.lower() in {".xlsx", ".xls", ".csv"})
        else:
            files.append(p)
    return files


def post(url, key, payload):
    req = Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "Content-Type": "application/json", "apikey": key, "Authorization": f"Bearer {key}"})
    try:
        with urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode())
    except HTTPError as e:
        raise RuntimeError(f"{e.code}: {e.read().decode(errors='replace')[:400]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--functions-url", help="e.g. http://localhost:8787/functions/v1 to use scripts/local-functions.ts")
    a = ap.parse_args()

    files = collect(a.paths)
    rows = []
    for f in files:
        rows += read_rows(f)
    report = {"files": len(files), "rows": len(rows)}
    if a.dry_run or not rows:
        print(json.dumps(report, indent=2))
        return

    env = load_env()
    url = (a.functions_url or env["SUPABASE_URL"].rstrip("/") + "/functions/v1").rstrip("/") + "/subscribers"
    report["endpoint"] = url
    totals = {k: 0 for k in ("added", "welcome_queued", "held_risky", "already_known", "suppressed", "duplicates_in_upload",
                             "invalid", "rejected_not_gmail", "rejected_to_never_send", "over_daily_limit")}
    samples = []
    for i in range(0, len(rows), 2000):
        res = post(url, env["SUPABASE_SERVICE_ROLE_KEY"], {"action": "import-batch", "subscribers": rows[i:i + 2000]})
        report["batch"] = res.get("batch")
        for k in totals:
            totals[k] += int(res.get(k) or 0)
        samples += res.get("invalid_samples") or []
    report.update(totals, invalid_samples=samples[:20])
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
