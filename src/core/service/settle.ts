/**
 * Wait for `work` to settle, but at most `ms` (bounded shutdown, 6.9): shutdown must not wait out slow, bounded observations such
 * as git sampling or a daemon read. Resolves true if it settled in time, false if it was abandoned. Never rejects.
 */
export async function settleWithin(work: Promise<unknown> | null, ms: number): Promise<boolean> {
  if (!work) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}