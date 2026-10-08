/**
 * The small Worker that hosts the burst limiter object (#3555), for the same two reasons the
 * confirm line has its own (#3500). In Slate's own 21 MB Worker, waking a ceiling object
 * loaded the whole app (a per address ceiling's first call took 0.8 to 1.15s against about
 * 40ms after), and every Slate deploy restarted every object (load run 37841835577: the first
 * confirm after one waited 1.5s on its key ceiling). This Worker exports the object and
 * nothing else; Slate binds `BURST_LIMITER` to it by script name (wrangler.jsonc), and a Slate
 * deploy no longer restarts it. `scripts/test-burst-limiter-worker.ts` walks this entry's
 * imports and fails on any file outside the counter's own.
 *
 * It has no address (wrangler.burst-limiter.jsonc), and its fetch handler only refuses.
 */
export { BurstLimiter } from "../burst-limiter";

const burstLimiterWorker = {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
export default burstLimiterWorker;
