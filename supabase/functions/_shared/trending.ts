// _shared/trending.ts
// Pure clustering math for the trending-topics agent. No I/O, no OpenAI, no
// Supabase — just vector helpers and a greedy online clusterer over recent
// article title embeddings. Kept side-effect-free so it is trivially testable
// and so the edge function stays a thin DB/LLM orchestration layer over it.

// Tunables (shared with the trending-topics function). Distances are cosine
// distance (0 = identical direction, 1 = orthogonal, 2 = opposite).
export const CLUSTER_MAX_DIST = 0.38; // greedy-cluster join threshold
export const ATTACH_MAX_DIST = 0.42;  // auto-attach a loose article to an approved topic
export const DEDUPE_MAX_DIST = 0.30;  // a new cluster this close to an existing topic is a dup
export const MIN_MEMBERS = 3;         // a cluster needs this many articles to surface
export const MIN_SOURCES = 2;         // ...from at least this many distinct outlets
export const WINDOW_HOURS = 72;       // only cluster articles scraped within this window
export const MAX_ARTICLES = 300;      // hard cap on candidates loaded per run

export type ClusterItem = { id: string; vec: number[]; scrapedAt: string; source: string };

// Parse a pgvector value: PostgREST returns it as a JSON string like "[0.1,0.2]",
// but a number[] may already be in hand. Returns [] on any failure.
export function parseVec(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.filter((n) => typeof n === "number") as number[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed.filter((n) => typeof n === "number") as number[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Cosine distance = 1 - cosine similarity. Zero-norm (or mismatched-length)
// vectors are treated as maximally distant (1) so they never falsely cluster.
export function cosineDist(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - sim;
}

// Elementwise mean of the given vectors, then L2-normalized. Returns [] when
// there is nothing usable to average.
export function meanCentroid(vecs: number[][]): number[] {
  const usable = vecs.filter((v) => v.length > 0);
  if (usable.length === 0) return [];
  const dim = usable[0].length;
  const sum = new Array(dim).fill(0);
  let counted = 0;
  for (const v of usable) {
    if (v.length !== dim) continue; // defensive: skip mismatched dims
    for (let i = 0; i < dim; i++) sum[i] += v[i];
    counted++;
  }
  if (counted === 0) return [];
  for (let i = 0; i < dim; i++) sum[i] /= counted;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return sum;
  for (let i = 0; i < dim; i++) sum[i] /= norm;
  return sum;
}

type Cluster = { members: ClusterItem[]; centroid: number[] };

// Greedy online clustering. Items must be pre-sorted newest-first. Each item
// joins the FIRST existing cluster whose centroid is within maxDist; on join the
// centroid is recomputed as the running mean of members (re-normalized). Items
// with an empty vector are skipped entirely.
export function greedyCluster(items: ClusterItem[], maxDist: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    if (!item.vec || item.vec.length === 0) continue; // defensive: skip vec-less items
    let placed = false;
    for (const cluster of clusters) {
      if (cosineDist(cluster.centroid, item.vec) <= maxDist) {
        cluster.members.push(item);
        cluster.centroid = meanCentroid(cluster.members.map((m) => m.vec));
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ members: [item], centroid: item.vec.slice() });
  }
  return clusters;
}

// How strongly cross-outlet coverage dominates the ranking. Each additional
// distinct source is worth this much, which is deliberately larger than the
// maximum recency mass a cluster can accumulate — so ANY multi-outlet story
// outranks EVERY single-outlet one. This is what "push a topic covered by
// several sources to the front of trending" means in practice.
export const SOURCE_WEIGHT = 8;

// Cluster hotness: distinct-source count (dominant term) + recency-weighted mass
// (each member decays with a ~36h half-life exponential). A story carried by
// many outlets always outranks one outlet spamming variations of a headline.
export function scoreCluster(members: ClusterItem[], now: number): number {
  let mass = 0;
  const sources = new Set<string>();
  for (const m of members) {
    const t = new Date(m.scrapedAt).getTime();
    const ageHours = Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : 0;
    mass += Math.exp(-ageHours / 36);
    if (m.source) sources.add(m.source.toLowerCase());
  }
  return sources.size * SOURCE_WEIGHT + mass;
}
