// One-time backfill: embed historical REVIEWED articles (approved/sent/rejected)
// that don't yet have an embedding, so the RAG corpus isn't empty on day one.
// Idempotent — only fills rows where embedding is null.
//
// Uses the SAME embedding recipe as supabase/functions/summarize-articles/index.ts:
//   input = `${title}\n${raw_content.slice(0,2000)}`   model = text-embedding-3-small
//
// Usage: node scripts/backfill-embeddings.mjs
// Reads .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, OPENAI_EMBED_MODEL

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

for (const [k, v] of Object.entries({ SUPABASE_URL, SERVICE_KEY, OPENAI_API_KEY })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  });
  if (!r.ok) throw new Error(`OpenAI embed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  const vec = body?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("empty embedding");
  return vec;
}

async function fetchBatch(limit) {
  const url = `${SUPABASE_URL}/rest/v1/articles` +
    `?status=in.(approved,sent,rejected)&embedding=is.null` +
    `&select=id,title,raw_content&limit=${limit}`;
  const r = await fetch(url, { headers: restHeaders });
  if (!r.ok) throw new Error(`fetch articles ${r.status}: ${await r.text()}`);
  return r.json();
}

async function patchEmbedding(id, vec) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/articles?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ embedding: JSON.stringify(vec) })
  });
  if (!r.ok) throw new Error(`patch ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function main() {
  console.log(`Backfilling embeddings (${EMBED_MODEL}) for reviewed articles...`);
  let total = 0, failed = 0;
  const CONCURRENCY = 5;

  while (true) {
    const batch = await fetchBatch(50);
    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (a) => {
        try {
          const input = `${a.title}\n${(a.raw_content ?? "").slice(0, 2000)}`.trim();
          const vec = await embed(input);
          await patchEmbedding(a.id, vec);
          total++;
        } catch (e) {
          failed++;
          console.log(`  ! ${a.id}: ${e.message}`);
        }
      }));
      await sleep(250); // gentle on rate limits
    }
    console.log(`  ...${total} embedded so far`);
  }

  console.log(`\nDone: ${total} embedded, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
