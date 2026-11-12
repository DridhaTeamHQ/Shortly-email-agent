// Sends the daily technical work report (owner, 2026-11-12) to the owner only.
//
//   node scripts/send-work-report.mjs <report.html> "<subject>"
//
// Reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION from .env and
// calls Amazon SES v2 directly (signed request, no extra packages). Sent WITHOUT
// the configuration set, like the other internal reports, so it never mixes into
// subscriber statistics. Recipient: WORK_REPORT_TO in .env only (never committed).
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";

const root = new URL("../", import.meta.url);
for (const line of readFileSync(new URL(".env", root), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
}

const [file, subject] = process.argv.slice(2);
if (!file || !subject) {
  console.error('usage: node scripts/send-work-report.mjs <report.html> "<subject>"');
  process.exit(1);
}
const html = readFileSync(file, "utf8");
const to = (process.env.WORK_REPORT_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!to.length) {
  console.error("WORK_REPORT_TO is not set in .env - report not sent");
  process.exit(1);
}
const from = "dailymattr work report <team@dailymattr.com>";
const region = process.env.AWS_REGION, keyId = process.env.AWS_ACCESS_KEY_ID, secret = process.env.AWS_SECRET_ACCESS_KEY;
if (!region || !keyId || !secret) {
  console.error("AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing in .env");
  process.exit(1);
}

// Raw MIME: the HTML report plus the Excel copy (same name, .xlsx) when it exists.
const xlsxPath = file.replace(/\.html$/, ".xlsx");
let attachment = null;
try { attachment = readFileSync(xlsxPath); } catch { /* no Excel copy */ }
const boundary = `wr-${Date.now().toString(36)}`;
const b64 = (buf) => buf.toString("base64").replace(/.{76}/g, "$&\r\n");
const encSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
const parts = [
  `From: ${from}`, `To: ${to.join(", ")}`, `Subject: ${encSubject}`, "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
  `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
  b64(Buffer.from(html, "utf8")), "",
];
if (attachment) {
  const name = xlsxPath.split(/[\\/]/).pop().replace(/^/, "dailymattr-work-report-");
  parts.push(`--${boundary}`,
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="${name}"`,
    "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"`, "",
    b64(attachment), "");
}
parts.push(`--${boundary}--`, "");
const body = JSON.stringify({
  Content: { Raw: { Data: Buffer.from(parts.join("\r\n"), "utf8").toString("base64") } },
});

// AWS Signature Version 4
const host = `email.${region}.amazonaws.com`, path = "/v2/email/outbound-emails";
const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
const day = now.slice(0, 8);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
const canonical = ["POST", path, "", `content-type:application/json\nhost:${host}\nx-amz-date:${now}\n`, "content-type;host;x-amz-date", sha(body)].join("\n");
const scope = `${day}/${region}/ses/aws4_request`;
const toSign = ["AWS4-HMAC-SHA256", now, scope, sha(canonical)].join("\n");
const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "ses"), "aws4_request");
const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");

const res = await fetch(`https://${host}${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Amz-Date": now,
    Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
  },
  body,
});
const text = await res.text();
if (!res.ok) {
  console.error(`SES error ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(`sent to ${to.join(", ")}: ${JSON.parse(text).MessageId}`);
