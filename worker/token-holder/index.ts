/**
 * The small Worker that hosts the shared Google token holder (#3512), for the reason the
 * confirm line (#3500) and the burst limiter (#3555) have their own: waking the object
 * loads only the holder's rules and not the whole 21 MB app, which matters for an object
 * whose whole job is to answer faster than a mint. Slate binds `TOKEN_HOLDER` to it by
 * script name (wrangler.jsonc). `scripts/test-token-holder-worker.ts` walks this entry's
 * imports and fails on any file outside the holder's own, so the app cannot creep back in.
 *
 * It has no address (wrangler.token-holder.jsonc), and its fetch handler only refuses: the
 * object is reached through Slate's binding and never through this Worker's own fetch.
 */
export { TokenHolder } from "../token-holder";

const tokenHolderWorker = {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
export default tokenHolderWorker;
