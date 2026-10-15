// Read a management API's listing again until it reflects a change, within a bound
// (#3783, #3787).
//
// Cloudflare's secret listing and Supabase's branch listing both lag a delete they
// have already accepted. The teardown read each once, straight after the delete, so a
// delete that landed failed the run twice: run 38800509328 on the Worker's secrets and
// run 38812653636 on the branch, which a read minutes later showed gone (L775).
//
// One loop for both callers, so the bound and the pace are decided once.

/** The wait between re-reads. */
export const RELIST_EVERY_MS = 5_000;
/** How many waits before the last read decides: 24 x 5s, two minutes. */
export const RELIST_ATTEMPTS = 24;

/**
 * Read, and while `settled` says the read does not decide yet, wait `RELIST_EVERY_MS` and
 * read again, at most `RELIST_ATTEMPTS` times. Returns the last read, which decides, and
 * how long was spent waiting, so a failure can say how long it looked.
 *
 * `settled` must count a FAILED read as settled: a read that did not answer is never
 * evidence the change landed, and waiting on one only delays saying so (L215).
 */
export async function relistUntil<T>(args: {
  read: () => Promise<T>;
  settled: (last: T) => boolean;
  /** Injected so no test waits for real (L524). */
  sleep: (ms: number) => Promise<void>;
}): Promise<{ last: T; waitedMs: number }> {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    const last = await args.read();
    if (args.settled(last) || attempt === RELIST_ATTEMPTS) return { last, waitedMs };
    await args.sleep(RELIST_EVERY_MS);
    waitedMs += RELIST_EVERY_MS;
  }
}
