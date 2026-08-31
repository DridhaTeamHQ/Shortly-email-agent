"""Import a named Excel batch and send welcome emails only to new contacts.

Credentials are read from environment variables so they are never stored in the
repository. Existing and unsubscribed contacts are intentionally left alone.
"""

import argparse
import json
import os
import re
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd


EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def request_json(url, headers, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urlopen(request, timeout=90) as response:
            return json.loads(response.read().decode())
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"API request failed ({error.code}): {detail}") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--sheet", required=True)
    parser.add_argument("--group", required=True)
    parser.add_argument("--send-welcome", action="store_true")
    args = parser.parse_args()

    url = os.environ["SUBSCRIBERS_FUNCTION_URL"]
    headers = {
        "Content-Type": "application/json",
        "apikey": os.environ["SUPABASE_ANON_KEY"],
        "Authorization": f"Bearer {os.environ['SUPABASE_ANON_KEY']}",
        "x-agent-token": os.environ["SHORTLY_AGENT_SHARED_TOKEN"],
    }

    frame = pd.read_excel(args.workbook, sheet_name=args.sheet)
    required = {"Name", "Email"}
    if not required.issubset(frame.columns):
        raise RuntimeError(f"Expected columns {sorted(required)}, found {frame.columns.tolist()}")

    by_email = {}
    invalid = []
    for _, row in frame.iterrows():
        email = str(row["Email"] if pd.notna(row["Email"]) else "").strip().lower()
        if not EMAIL_PATTERN.fullmatch(email):
            invalid.append(email)
            continue
        name = str(row["Name"] if pd.notna(row["Name"]) else "").strip()
        by_email[email] = {"email": email, "full_name": name or None}

    live = request_json(url, headers)
    groups = {group["name"].casefold(): group for group in live.get("groups", [])}
    group = groups.get(args.group.casefold())
    if not group:
        created = request_json(url, headers, {"action": "create-group", "name": args.group})
        group = created["group"]

    existing = {str(item["email"]).lower(): item for item in live.get("subscribers", [])}
    new_rows = [row for email, row in by_email.items() if email not in existing]
    existing_subscribed = sum(1 for email in by_email if existing.get(email, {}).get("status") == "subscribed")
    existing_unsubscribed = sum(1 for email in by_email if existing.get(email, {}).get("status") == "unsubscribed")

    import_results = []
    if new_rows:
        # The Edge Function checks existing emails through a PostgREST `in`
        # filter, so keep each request small enough for URL limits.
        for index in range(0, len(new_rows), 75):
            import_results.append(request_json(url, headers, {
                "action": "import",
                "subscribers": new_rows[index:index + 75],
                "group_id": group["id"],
            }))

    welcome_sent = 0
    welcome_failed = []
    if args.send_welcome:
        for index in range(0, len(new_rows), 10):
            batch = [row["email"] for row in new_rows[index:index + 10]]
            result = request_json(url, headers, {"action": "send-welcome", "emails": batch})
            for item in result.get("results", []):
                if item.get("sent"):
                    welcome_sent += 1
                else:
                    welcome_failed.append({"email": item.get("email"), "error": item.get("error", "Unknown error")})
            # Keep the job within SES's configured send rate and avoid function bursts.
            if index + 10 < len(new_rows):
                time.sleep(0.35)

    report = {
        "sheet_rows": len(frame),
        "valid_unique": len(by_email),
        "invalid_rows": len(invalid),
        "group": group["name"],
        "group_id": group["id"],
        "new_imported": len(new_rows),
        "existing_subscribed_unchanged": existing_subscribed,
        "existing_unsubscribed_unchanged": existing_unsubscribed,
        "imported_confirmed": sum(result.get("created", 0) for result in import_results),
        "import_updated": sum(result.get("updated", 0) for result in import_results),
        "welcome_sent": welcome_sent,
        "welcome_failed": welcome_failed,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
