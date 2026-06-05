// Phase 2 — export editor-validated examples to OpenAI chat fine-tune JSONL.
//
// Target = what the editor actually kept: status in (approved, sent), using the FINAL
// summary (edited_summary ?? summary), final section, and prominence. Reuses the same
// SYSTEM_PROMPT + userPrompt as production so the tuned model is a drop-in.
//
// HARD GATE: refuses to write a file below 100 examples (fine-tuning over-fits below that).
//
// Usage: node scripts/export-training-data.mjs
// Writes: training/shortly-YYYYMMDD.jsonl

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env, ROOT, SYSTEM_PROMPT, buildUserPrompt, selectArticles } from "./_shared.mjs";

const MIN_EXAMPLES = 100;
const e = env();

function stamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function main() {
  console.log("Exporting editor-validated examples...");
  // Human-kept outputs only. Pull edited ones first (corrections), then approved-as-is.
  const rows = await selectArticles(
    e,
    "status=in.(approved,sent)&summary=not.is.null" +
    "&select=id,title,url,source,raw_content,summary,edited_summary,section,prominence" +
    "&order=reviewed_at.desc&limit=5000"
  );

  const examples = rows
    .map((a) => {
      const finalSummary = (a.edited_summary || a.summary || "").trim();
      if (!finalSummary) return null;
      const assistant = JSON.stringify({
        summary: finalSummary,
        section: a.section === "ahead" ? "ahead" : "wrapped",
        prominence: Math.min(5, Math.max(1, parseInt(a.prominence) || 2))
      });
      return {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(a) },
          { role: "assistant", content: assistant }
        ]
      };
    })
    .filter(Boolean);

  const edited = rows.filter((a) => a.edited_summary).length;
  console.log(`  Eligible: ${examples.length} (${edited} editor-corrected, ${examples.length - edited} approved-as-is)`);

  if (examples.length < MIN_EXAMPLES) {
    console.log(`\nGATE: only ${examples.length}/${MIN_EXAMPLES} examples. RAG-only until >=${MIN_EXAMPLES}.`);
    console.log("No file written. Keep reviewing; the RAG layer is already learning continuously.");
    process.exit(0);
  }

  const dir = resolve(ROOT, "training");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `shortly-${stamp()}.jsonl`);
  writeFileSync(file, examples.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  console.log(`\nWrote ${examples.length} examples to ${file}`);
  console.log("Next: node scripts/train-model.mjs " + file);
}

main().catch((err) => { console.error(err); process.exit(1); });
