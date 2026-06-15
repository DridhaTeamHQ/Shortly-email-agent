import { access } from "node:fs/promises";

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "scripts/static-server.mjs",
  "supabase/schema.sql",
  "supabase/functions/send-article/index.ts",
  "supabase/functions/corporate-case-agent/index.ts",
  "supabase/functions/_shared/corporate-case-sources.ts",
  "supabase/functions/editorial-topic-agent/index.ts",
  "supabase/functions/_shared/editorial-topics.ts",
  "src/scraper-adapter.ts",
  "README.md"
];

await Promise.all(requiredFiles.map((file) => access(file)));
console.log(`Checked ${requiredFiles.length} project files.`);
