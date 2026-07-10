// _shared/embeddings.ts
// Title embeddings for story clustering (text-embedding-3-small, 1536 dims,
// ~$0.02 per MILLION tokens — a headline is ~15 tokens, so effectively free).
// One batched call embeds a whole scrape run. Never throws: null on any
// failure so callers fall back to token-overlap matching.

const EMBED_MODEL = Deno.env.get("EMBED_MODEL") ?? "text-embedding-3-small";

export async function embedTexts(apiKey: string, texts: string[]): Promise<number[][] | null> {
  const inputs = texts.map((t) => String(t || "").slice(0, 500)).filter(Boolean);
  if (inputs.length === 0) return [];
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (rows.length !== inputs.length) return null;
    return rows.map((r: { embedding: number[] }) => r.embedding);
  } catch {
    return null;
  }
}

export async function embedText(apiKey: string, text: string): Promise<number[] | null> {
  const out = await embedTexts(apiKey, [text]);
  return out && out[0] ? out[0] : null;
}
