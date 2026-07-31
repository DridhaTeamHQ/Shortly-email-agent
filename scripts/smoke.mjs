// Smoke test: approve 5 articles, verify 6th is blocked, send digest.
const base = "http://localhost:4173";
const j = (path, opts = {}) =>
  fetch(base + path, { headers: { "Content-Type": "application/json" }, ...opts })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const list = await j("/api/list-articles?status=summarized&limit=20");
const ids = list.body.articles.map((a) => a.id);
console.log(`Found ${ids.length} summarized articles`);

let approved = 0;
for (let i = 0; i < Math.min(11, ids.length); i++) {
  const r = await j("/api/review-article", {
    method: "POST",
    body: JSON.stringify({ id: ids[i], action: "approve" })
  });
  if (r.status === 200) {
    approved++;
    console.log(`#${i + 1} approved`);
  } else {
    console.log(`#${i + 1} BLOCKED -> ${r.status} ${JSON.stringify(r.body)}`);
  }
}
console.log(`\nTotal approved this run: ${approved} (expected 10)`);

const counts = await j("/api/list-articles?status=all");
console.log("counts:", counts.body.counts);
