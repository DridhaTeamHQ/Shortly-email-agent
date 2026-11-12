"""Builds the Excel copy of the daily work report (owner, 2026-11-12).

    python -I scripts/build-work-report-xlsx.py docs/work-log/2026-11-12.json
      -> docs/work-log/2026-11-12.xlsx

Sheets: Summary, Time sheet, Changes, Flow charts (boxes drawn with coloured,
merged cells and arrows), Problems, Explanations, Next. Same JSON as
build-work-report.mjs.
"""
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

src = sys.argv[1]
r = json.load(open(src, encoding="utf-8"))

KIND = {
    "function": ("E1F5EE", "0F6E56", "085041", "Function (server)"),
    "database": ("EEEDFE", "534AB7", "3C3489", "Database"),
    "owner": ("FAEEDA", "854F0B", "633806", "You"),
    "outside": ("F1EFE8", "888780", "444441", "Outside service"),
    "blocked": ("FAECE7", "993C1D", "712B13", "Stopped / never mailed"),
    "check": ("E6F1FB", "185FA5", "0C447C", "Decision"),
}
BLUE = "3979FF"
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(wrap_text=True, horizontal="center", vertical="center")


def plain(s):
    return re.sub(r"`([^`]+)`", r"\1", str(s or ""))


def header(ws, row, values, widths=None):
    for i, v in enumerate(values, 1):
        c = ws.cell(row=row, column=i, value=v)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=BLUE)
        c.alignment = WRAP
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[chr(64 + i)].width = w


def title(ws, text):
    ws["A1"] = text
    ws["A1"].font = Font(bold=True, size=14, color=BLUE)
    ws["A2"] = r.get("date", "")
    ws["A2"].font = Font(color="5F5E5A")


wb = Workbook()

# Summary
ws = wb.active
ws.title = "Summary"
title(ws, f"dailymattr work report - {r.get('title', '')}")
row = 4
for s in r.get("summary", []):
    ws.cell(row=row, column=1, value="•")
    c = ws.cell(row=row, column=2, value=plain(s))
    c.alignment = WRAP
    ws.row_dimensions[row].height = 45
    row += 1
row += 1
if r.get("numbers"):
    header(ws, row, ["", "Item", "Number"])
    row += 1
    for label, value in r["numbers"]:
        ws.cell(row=row, column=2, value=plain(label)).alignment = WRAP
        ws.cell(row=row, column=3, value=plain(value)).alignment = WRAP
        row += 1
ws.column_dimensions["A"].width = 4
ws.column_dimensions["B"].width = 90
ws.column_dimensions["C"].width = 40

# Time sheet
ws = wb.create_sheet("Time sheet")
title(ws, "Time sheet")
has_hours = any(t.get("hours") for t in r.get("timesheet", []))
header(ws, 4, ["Task", "What was done"] + (["Hours"] if has_hours else []), [34, 90, 10])
for i, t in enumerate(r.get("timesheet", []), 5):
    ws.cell(row=i, column=1, value=plain(t["task"])).alignment = WRAP
    ws.cell(row=i, column=2, value=plain(t["detail"])).alignment = WRAP
    if has_hours:
        ws.cell(row=i, column=3, value=t.get("hours"))
    ws.row_dimensions[i].height = 35

# Changes
ws = wb.create_sheet("Changes")
title(ws, "Changes, by place")
header(ws, 4, ["Place", "Change"], [24, 120])
row = 5
labels = [("database", "Database"), ("backend", "Backend (edge functions)"), ("dashboard", "Dashboard"),
          ("settings", "Settings and secrets"), ("files", "Code files and folders"), ("commits", "GitHub commits")]
for key, label in labels:
    for item in r.get("changes", {}).get(key, []) or ["No changes."]:
        ws.cell(row=row, column=1, value=label).font = Font(bold=True)
        ws.cell(row=row, column=2, value=plain(item)).alignment = WRAP
        ws.row_dimensions[row].height = 32
        row += 1

# Flow charts: main column B:D, arrow column E, side box F:H
ws = wb.create_sheet("Flow charts")
title(ws, "Workflows and flow charts")
for col, w in zip("ABCDEFGH", [3, 16, 16, 16, 12, 14, 14, 14]):
    ws.column_dimensions[col].width = w


def draw_box(row, c1, c2, step):
    fill, border, ink, _ = KIND.get(step.get("kind"), KIND["outside"])
    ws.merge_cells(start_row=row, start_column=c1, end_row=row, end_column=c2)
    cell = ws.cell(row=row, column=c1, value=plain(step["t"]) + (f"\n{plain(step['s'])}" if step.get("s") else ""))
    cell.alignment = CENTER
    cell.font = Font(bold=True, color=ink)
    side = Side(style="thin", color=border)
    for c in range(c1, c2 + 1):
        x = ws.cell(row=row, column=c)
        x.fill = PatternFill("solid", fgColor=fill)
        x.border = Border(top=side, bottom=side, left=side if c == c1 else None, right=side if c == c2 else None)
    ws.row_dimensions[row].height = 38


row = 4
for f in r.get("flows", []):
    ws.cell(row=row, column=2, value=plain(f["title"])).font = Font(bold=True, size=12)
    row += 1
    if f.get("explain"):
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=8)
        c = ws.cell(row=row, column=2, value=plain(f["explain"]))
        c.alignment = WRAP
        ws.row_dimensions[row].height = 48
        row += 1
    steps = f["steps"]
    for i, st in enumerate(steps):
        draw_box(row, 2, 4, st)
        if st.get("side"):
            a = ws.cell(row=row, column=5, value=f"{st['side'].get('label', '')} →")
            a.alignment = CENTER
            a.font = Font(color="5F5E5A")
            draw_box(row, 6, 8, st["side"])
        row += 1
        if i < len(steps) - 1:
            ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=4)
            a = ws.cell(row=row, column=2, value="↓" + (f"  {st['label']}" if st.get("label") else ""))
            a.alignment = CENTER
            a.font = Font(color="5F5E5A", size=12)
            row += 1
    kinds = []
    for st in steps:
        for k in (st.get("kind"), (st.get("side") or {}).get("kind")):
            if k and k not in kinds:
                kinds.append(k)
    col = 2
    for k in kinds:
        fill, border, ink, label = KIND[k]
        c = ws.cell(row=row, column=col, value=label)
        c.fill = PatternFill("solid", fgColor=fill)
        c.font = Font(color=ink, size=9)
        c.alignment = CENTER
        col += 1
    row += 3

# Problems
if r.get("issues"):
    ws = wb.create_sheet("Problems")
    title(ws, "Problems found and how they were fixed")
    header(ws, 4, ["Problem", "Why it happened", "Fix"], [45, 60, 60])
    for i, it in enumerate(r["issues"], 5):
        for j, k in enumerate(["problem", "cause", "fix"], 1):
            ws.cell(row=i, column=j, value=plain(it[k])).alignment = WRAP
        ws.row_dimensions[i].height = 60

# Explanations
if r.get("explanations"):
    ws = wb.create_sheet("Explanations")
    title(ws, "Explanations (questions asked today)")
    header(ws, 4, ["Question", "Answer"], [45, 110])
    for i, e in enumerate(r["explanations"], 5):
        ws.cell(row=i, column=1, value=plain(e["q"])).alignment = WRAP
        ws.cell(row=i, column=2, value=plain(e["a"])).alignment = WRAP
        ws.row_dimensions[i].height = 60

# Next
ws = wb.create_sheet("Next")
title(ws, "Next / pending")
ws.column_dimensions["B"].width = 120
for i, n in enumerate(r.get("next", []), 4):
    ws.cell(row=i, column=1, value="•")
    ws.cell(row=i, column=2, value=plain(n)).alignment = WRAP
    ws.row_dimensions[i].height = 30

out = re.sub(r"\.json$", ".xlsx", src)
wb.save(out)
print(out)
