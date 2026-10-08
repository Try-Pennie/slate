/**
 * The small Worker that hosts the confirm line object (#3500).
 *
 * A line object or the pool grouping directory left idle for minutes took about 0.9 to
 * 1.35s to answer its first call while it lived in Slate's own 21 MB Worker, because
 * waking it loaded the whole app (#3498). Load run 37829565739 measured the same on a
 * cold isolate's first line call: 1.1 to 1.4s against about 0.4s warm, the largest part
 * of the confirm startup wait. This Worker exports the object and nothing else, so a
 * wake loads only the line's own rules; Slate binds `CONFIRM_LINE` to it by script name
 * (wrangler.jsonc). `scripts/test-confirm-line-binding.ts` walks this entry's imports and
 * fails on any file outside the line's own, so the app cannot creep back in.
 *
 * It has no address (wrangler.confirm-line.jsonc), and its fetch handler only refuses:
 * the object is reached through Slate's binding and never through this Worker's own fetch.
 */
export { ConfirmLine } from "../confirm-line";

const lineWorker = {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
export default lineWorker;
