// Generates config.js from environment variables at build time (Vercel).
const fs = require("node:fs");

const supabaseUrl = process.env.SUPABASE_URL || "";
const anonKey = process.env.SUPABASE_ANON_KEY || "";
const dailyCap = process.env.DAILY_CAP || "10";

// Extract project ref from URL: https://<ref>.supabase.co
const ref = supabaseUrl.match(/https:\/\/(.+?)\.supabase\.co/)?.[1] || "";

if (!ref || !anonKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars.");
  process.exit(1);
}

const functionsBase = `https://${ref}.functions.supabase.co`;

const config = `// Auto-generated at build time — do not edit manually.
window.SHORTLY = {
  list:        "${functionsBase}/list-articles",
  review:      "${functionsBase}/review-article",
  digest:      "${functionsBase}/send-daily-digest",
  submit:      "${functionsBase}/send-article",
  subscribers: "${functionsBase}/subscribers",
  anonKey:     "${anonKey}",
  dailyCap:    ${parseInt(dailyCap, 10)},
  reviewer:    "qa"
};
`;

fs.writeFileSync("config.js", config, "utf-8");
console.log(`Generated config.js (ref: ${ref})`);
