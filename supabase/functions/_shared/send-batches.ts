// _shared/send-batches.ts
// One paced send loop for every digest path. Sends in small concurrent
// batches with a pause between them so a full-audience send never bursts:
// bursting is what got 67/100 delivered in the 2026-08-15 load test (Gmail
// throttled the burst), and SES itself enforces a per-second send rate.
//
// Pacing is env-tunable so a warm-up schedule can be widened day by day
// WITHOUT a redeploy. Env always wins over the caller's values, so raising the
// rate is a secrets change, not a code change:
//   SEND_BATCH_SIZE      concurrent sends per batch (default 5)
//   SEND_BATCH_PAUSE_MS  pause between batches in ms (default 2000)
//
// Defaults are deliberately conservative -- 5 per 2s is ~2.5/sec. A brand new
// SES account has no sending reputation, and after a suspension the safe move
// is to re-earn it slowly rather than reopen at full volume.
//
// The worker returns true (sent) / false (failed); a thrown error counts as
// failed without aborting the run.

export type BatchOpts = {
  batchSize?: number; // concurrent sends per batch
  pauseMs?: number;   // wait between batches
};

function envNum(name: string): number | null {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolvePacing(opts: BatchOpts = {}): { batchSize: number; pauseMs: number } {
  const batchSize = Math.max(1, envNum("SEND_BATCH_SIZE") ?? opts.batchSize ?? 5);
  const pauseMs = Math.max(0, envNum("SEND_BATCH_PAUSE_MS") ?? opts.pauseMs ?? 2000);
  return { batchSize, pauseMs };
}

export async function sendInBatches<T>(
  items: T[],
  worker: (item: T) => Promise<boolean>,
  opts: BatchOpts = {},
): Promise<{ sent: number; failed: number; batchSize: number; pauseMs: number }> {
  const { batchSize, pauseMs } = resolvePacing(opts);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        return await worker(item);
      } catch {
        return false;
      }
    }));
    sent += results.filter(Boolean).length;
    failed += results.length - results.filter(Boolean).length;
    if (pauseMs > 0 && i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  return { sent, failed, batchSize, pauseMs };
}
