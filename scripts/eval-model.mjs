// Phase 2 — eval gate: compare BASE vs CANDIDATE on held-out reviewed articles.
// Prints a side-by-side and aggregate metrics for human judgment. Promotion is MANUAL.
//
// Usage: node scripts/eval-model.mjs [N]   (default N=15)

import { env, getConfig, selectArticles, buildUserPrompt, chat } from "./_shared.mjs";

const e = env();
const N = Math.max(1, parseInt(process.argv[2] || "15", 10));

const wordCount = (s) => (s || "").split(/\s+/).filter(Boolean).length;
// crude token-overlap similarity to the editor's final summary (0..1)
function overlap(a, b) {
  const A = new Set((a || "").toLowerCase().match(/[a-z0-9]+/g) || []);
  const B = new Set((b || "").toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / new Set([...A, ...B]).size;
}

async function scoreModel(label, model, rows) {
  let sectionHits = 0, lenOk = 0, simSum = 0, n = 0;
  const samples = [];
  for (const a of rows) {
    const finalSummary = (a.edited_summary || a.summary || "").trim();
    const finalSection = a.section === "ahead" ? "ahead" : "wrapped";
    try {
      const out = await chat(e.OPENAI_API_KEY, model, buildUserPrompt(a));
      const wc = wordCount(out.summary);
      if (out.section === finalSection) sectionHits++;
      if (wc >= 50 && wc <= 100) lenOk++;
      const sim = overlap(out.summary, finalSummary);
      simSum += sim; n++;
      if (samples.length < 3) samples.push({ title: a.title, out: out.summary, target: finalSummary });
    } catch (err) {
      console.log(`  (${label}) skip ${a.id}: ${err.message}`);
    }
  }
  return {
    label, model,
    sectionAcc: n ? Math.round((sectionHits / n) * 100) : 0,
    lenAdherence: n ? Math.round((lenOk / n) * 100) : 0,
    avgOverlap: n ? +(simSum / n).toFixed(3) : 0,
    n, samples
  };
}

async function main() {
  const candidate = await getConfig(e, "OPENAI_MODEL_CANDIDATE");
  if (!candidate) {
    console.error("No OPENAI_MODEL_CANDIDATE in app_config. Run train-model.mjs first.");
    process.exit(1);
  }
  const base = (await getConfig(e, "OPENAI_MODEL")) || e.OPENAI_MODEL;

  const rows = await selectArticles(
    e,
    "status=in.(approved,sent)&summary=not.is.null" +
    "&select=id,title,url,source,raw_content,summary,edited_summary,section&order=reviewed_at.desc&limit=" + N
  );
  console.log(`Evaluating on ${rows.length} held-out reviewed articles.\n  base:      ${base}\n  candidate: ${candidate}\n`);

  const [b, c] = [await scoreModel("base", base, rows), await scoreModel("candidate", candidate, rows)];

  const fmt = (r) => `  ${r.label.padEnd(10)} section=${r.sectionAcc}%  length=${r.lenAdherence}%  overlap=${r.avgOverlap}  (n=${r.n})`;
  console.log("Metrics (higher = closer to editors' final):");
  console.log(fmt(b));
  console.log(fmt(c));

  console.log("\nSample candidate outputs vs editor final:");
  c.samples.forEach((s, i) => {
    console.log(`\n[${i + 1}] ${s.title}`);
    console.log(`  candidate: ${s.out}`);
    console.log(`  editor:    ${s.target}`);
  });

  const wins = (c.sectionAcc >= b.sectionAcc) && (c.avgOverlap >= b.avgOverlap) && (c.lenAdherence >= b.lenAdherence - 5);
  console.log(`\nVerdict: candidate ${wins ? "MATCHES/BEATS" : "does NOT beat"} base.`);
  console.log("Promotion is manual. If you accept the candidate, run (SQL editor or REST):");
  console.log(`  insert into app_config(key,value) values('OPENAI_MODEL','${candidate}')`);
  console.log(`  on conflict (key) do update set value=excluded.value, updated_at=now();`);
  console.log("Rollback any time: delete that row (falls back to env OPENAI_MODEL).");
}

main().catch((err) => { console.error(err); process.exit(1); });
