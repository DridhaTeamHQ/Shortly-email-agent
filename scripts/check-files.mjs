import { access } from "node:fs/promises";

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "scripts/static-server.mjs",
  "supabase/schema.sql",
  "supabase/functions/send-article/index.ts",
  "src/scraper-adapter.ts",
  "README.md"
];

await Promise.all(requiredFiles.map((file) => access(file)));
console.log(`Checked ${requiredFiles.length} project files.`);
