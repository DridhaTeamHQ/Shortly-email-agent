// _shared/send-batches.ts
// One paced send loop for every digest path. Sends in small concurrent
// batches with a pause between them so a full-audience send never bursts:
// bursting is what got 67/100 delivered in the 2026-08-15 load test (Gmail
// throttled the burst), and SES itself enforces a per-second send rate.
//
// The worker returns true (sent) / false (failed); a thrown error counts as
// failed without aborting the run.

export type BatchOpts = {
  batchSize?: number; // concurrent sends per batch
  pauseMs?: number;   // wait between batches
};

export async function sendInBatches<T>(
  items: T[],
  worker: (item: T) => Promise<boolean>,
  opts: BatchOpts = {},
): Promise<{ sent: number; failed: number }> {
  const batchSize = Math.max(1, opts.batchSize ?? 8);
  const pauseMs = Math.max(0, opts.pauseMs ?? 1000);
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
  return { sent, failed };
}
