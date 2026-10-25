/**
 * The Cloudflare data centre (colo) a `cf-ray` names (#3366, #3784).
 *
 * Cloudflare puts the colo on every `cf-ray` as its suffix (`8f2c1a9b4d5e6f70-SEA`).
 * On an ANSWER Slate received from a service behind Cloudflare (Supabase), it names
 * the colo that service's edge answered at. A Worker's subrequest enters the other
 * zone in the colo the Worker runs in, so on a Supabase answer it says where Slate
 * RAN: the same reading as `request.cf.colo` in Supabase's own edge logs, which is
 * how placement was confirmed (docs/cloudflare-platform-notes.md, "Where a confirm
 * ran"). Pure, with no import, because the call budget, which client chunks can
 * reach, reads it.
 */
export function coloFromRay(ray: string | null | undefined): string | null {
  if (!ray) return null;
  const m = /-([A-Z]{3,4})$/.exec(ray.trim());
  return m ? m[1]! : null;
}
