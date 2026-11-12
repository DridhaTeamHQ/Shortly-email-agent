// Builds the daily technical work report email (owner, 2026-11-12).
//
//   node scripts/build-work-report.mjs docs/work-log/2026-11-12.json
//     -> writes docs/work-log/2026-11-12.html (Gmail-safe: tables + inline styles,
//        flow charts drawn as boxes and arrows because Gmail does not show SVG)
//
// JSON shape:
// { date, title, summary: [..], timesheet: [{ task, detail, hours? }],
//   changes: { database: [..], backend: [..], dashboard: [..], files: [..], commits: [..], settings: [..] },
//   flows: [{ title, explain, steps: [{ t, s, kind, label?, side?: { t, s, kind, label } }] }],
//   explanations: [{ q, a }], issues: [{ problem, cause, fix }], next: [..], numbers: [[label, value]] }
// kind: function | database | owner | outside | blocked | check
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/build-work-report.mjs <day.json>"); process.exit(1); }
const r = JSON.parse(readFileSync(file, "utf8"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// allow `code` spans in text
const txt = (s) => esc(s).replace(/`([^`]+)`/g, '<code style="background:#F1EFE8;padding:1px 4px;border-radius:3px;font-size:13px">$1</code>');

const KIND = {
  function: ["#E1F5EE", "#0F6E56", "#085041", "Function (server)"],
  database: ["#EEEDFE", "#534AB7", "#3C3489", "Database"],
  owner: ["#FAEEDA", "#854F0B", "#633806", "You"],
  outside: ["#F1EFE8", "#888780", "#444441", "Outside service"],
  blocked: ["#FAECE7", "#993C1D", "#712B13", "Stopped / never mailed"],
  check: ["#E6F1FB", "#185FA5", "#0C447C", "Decision"],
};
const box = (b) => {
  const [bg, border, ink] = KIND[b.kind] ?? KIND.outside;
  return `<td style="background:${bg};border:1px solid ${border};border-radius:8px;padding:8px 14px;text-align:center;color:${ink};font-size:14px;min-width:220px">
    <b>${txt(b.t)}</b>${b.s ? `<br><span style="font-size:12px">${txt(b.s)}</span>` : ""}</td>`;
};
const flow = (f) => {
  const rows = f.steps.map((st, i) => {
    const side = st.side
      ? `<td style="color:#888780;font-size:12px;padding:0 8px;white-space:nowrap">${esc(st.side.label ?? "")} &rarr;</td>${box(st.side)}`
      : `<td></td><td></td>`;
    const arrow = i < f.steps.length - 1
      ? `<tr><td style="text-align:center;color:#888780;font-size:18px;line-height:20px;padding:2px 0">&darr;${st.label ? `<br><span style="font-size:11px">${esc(st.label)}</span>` : ""}</td><td></td><td></td></tr>`
      : "";
    return `<tr>${box(st)}${side}</tr>${arrow}`;
  }).join("");
  const kinds = [...new Set(f.steps.flatMap((s) => [s.kind, s.side?.kind]).filter(Boolean))];
  const legend = kinds.map((k) => `<span style="display:inline-block;width:10px;height:10px;background:${KIND[k][0]};border:1px solid ${KIND[k][1]};border-radius:2px;margin:0 4px 0 12px"></span>${KIND[k][3]}`).join("");
  return `<h3 style="font-size:16px;margin:24px 0 6px">${txt(f.title)}</h3>
    ${f.explain ? `<p style="margin:0 0 10px;color:#444441">${txt(f.explain)}</p>` : ""}
    <table cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0 0">${rows}</table>
    <p style="font-size:12px;color:#5F5E5A;margin:8px 0 0">${legend}</p>`;
};
const list = (items) => items?.length ? `<ul style="margin:6px 0 12px;padding-left:20px">${items.map((i) => `<li style="margin:3px 0">${txt(i)}</li>`).join("")}</ul>` : `<p style="color:#888780;margin:6px 0 12px">No changes.</p>`;
const h2 = (s) => `<h2 style="font-size:18px;border-bottom:2px solid #3979FF;padding-bottom:4px;margin:32px 0 10px">${esc(s)}</h2>`;
const table = (head, rows) => `<table cellpadding="6" style="border-collapse:collapse;font-size:14px;margin:6px 0 12px">
  <tr>${head.map((h) => `<th style="text-align:left;border-bottom:1px solid #B4B2A9;padding:6px 10px">${esc(h)}</th>`).join("")}</tr>
  ${rows.map((row) => `<tr>${row.map((c) => `<td style="border-bottom:1px solid #EEE;padding:6px 10px;vertical-align:top">${txt(c)}</td>`).join("")}</tr>`).join("")}</table>`;

const c = r.changes ?? {};
const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#2C2C2A;line-height:1.55;max-width:760px">
<p style="font-size:22px;margin:0"><b style="color:#3979FF">dailymattr</b> work report</p>
<p style="margin:2px 0 16px;color:#5F5E5A">${esc(r.date)}${r.title ? ` &middot; ${esc(r.title)}` : ""}</p>

${h2("Summary")}${list(r.summary)}
${r.numbers?.length ? table(["Item", "Number"], r.numbers) : ""}

${h2("Time sheet")}
${table(["Task", "What was done", ...(r.timesheet?.some((t) => t.hours) ? ["Hours"] : [])],
  (r.timesheet ?? []).map((t) => [t.task, t.detail, ...(t.hours ? [String(t.hours)] : [])]))}

${h2("Changes, by place")}
<h3 style="font-size:16px;margin:12px 0 4px">Database (tables, columns, SQL functions, triggers, cron jobs, migrations)</h3>${list(c.database)}
<h3 style="font-size:16px;margin:12px 0 4px">Backend (edge functions: new and changed)</h3>${list(c.backend)}
<h3 style="font-size:16px;margin:12px 0 4px">Dashboard</h3>${list(c.dashboard)}
<h3 style="font-size:16px;margin:12px 0 4px">Settings and secrets</h3>${list(c.settings)}
<h3 style="font-size:16px;margin:12px 0 4px">Code files and folders</h3>${list(c.files)}
<h3 style="font-size:16px;margin:12px 0 4px">GitHub commits</h3>${list(c.commits)}

${h2("Workflows and flow charts")}
${(r.flows ?? []).map(flow).join("")}

${r.issues?.length ? h2("Problems found and how they were fixed") + table(["Problem", "Why it happened", "Fix"], r.issues.map((i) => [i.problem, i.cause, i.fix])) : ""}

${r.explanations?.length ? h2("Explanations (questions asked today)") + r.explanations.map((e) => `<p style="margin:14px 0 4px"><b>${txt(e.q)}</b></p><p style="margin:0 0 6px">${txt(e.a)}</p>`).join("") : ""}

${h2("Next / pending")}${list(r.next)}
<p style="margin-top:32px;font-size:12px;color:#888780">Sent automatically every day at 7:00 PM IST. Internal report, only to the owner.</p>
</body></html>`;

const out = file.replace(/\.json$/, ".html");
writeFileSync(out, html);
console.log(out);
