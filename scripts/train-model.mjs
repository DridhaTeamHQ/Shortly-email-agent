// Phase 2 — upload a JSONL and run an OpenAI fine-tuning job.
// On success, writes the new model id to app_config.OPENAI_MODEL_CANDIDATE.
// NEVER touches app_config.OPENAI_MODEL (the live model). Promotion is a separate,
// deliberate human step after eval (see eval-model.mjs).
//
// Usage: node scripts/train-model.mjs training/shortly-YYYYMMDD.jsonl

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { env, setConfig } from "./_shared.mjs";

const e = env();
const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("Usage: node scripts/train-model.mjs <path-to-jsonl>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oa = (path, opts = {}) =>
  fetch(`https://api.openai.com/v1/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}`, ...(opts.headers || {}) }
  });

async function main() {
  // 1. Upload file (multipart)
  console.log(`Uploading ${file}...`);
  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  let r = await oa("files", { method: "POST", body: form });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
  const fileId = (await r.json()).id;
  console.log(`  file id: ${fileId}`);

  // 2. Create fine-tune job
  r = await oa("fine_tuning/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ training_file: fileId, model: e.BASE_FT_MODEL })
  });
  if (!r.ok) throw new Error(`create job ${r.status}: ${await r.text()}`);
  const job = await r.json();
  console.log(`  job id: ${job.id}  (base: ${e.BASE_FT_MODEL})`);

  // 3. Poll
  console.log("Polling (this can take a while)...");
  while (true) {
    await sleep(30000);
    r = await oa(`fine_tuning/jobs/${job.id}`);
    const j = await r.json();
    console.log(`  status: ${j.status}`);
    if (j.status === "succeeded") {
      console.log(`\nFine-tuned model: ${j.fine_tuned_model}`);
      await setConfig(e, "OPENAI_MODEL_CANDIDATE", j.fine_tuned_model);
      console.log("Saved to app_config.OPENAI_MODEL_CANDIDATE (NOT live).");
      console.log("Next: node scripts/eval-model.mjs   then promote manually if it wins.");
      return;
    }
    if (j.status === "failed" || j.status === "cancelled") {
      throw new Error(`job ${j.status}: ${JSON.stringify(j.error || {})}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
