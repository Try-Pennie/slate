import { NextResponse, type NextRequest } from "next/server";

// THROWAWAY diagnostic (#231 follow-up): measures Cloudflare Cache API hit
// latency vs the KV slot-cache (~264ms cold-key). Delete after we decide on the
// storage. Returns `x-probe: HIT|MISS|NOCACHE`; hit on a low-traffic key should
// be ~5-10ms at the Worker (colo-local) if the Cache API is the right store.
export const dynamic = "force-dynamic";

// `caches.default` is a Cloudflare runtime extension not in the standard lib types.
type CfCache = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };
const defaultCache = (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default;

export async function GET(req: NextRequest) {
  if (!defaultCache) {
    return NextResponse.json({ probe: "nocache" }, { headers: { "x-probe": "NOCACHE" } });
  }
  const key = new Request(new URL("/__cache_probe_key_v1", req.url).toString());
  const cached = await defaultCache.match(key);
  if (cached) {
    const body = await cached.text();
    return new NextResponse(body, {
      headers: { "x-probe": "HIT", "content-type": "application/json" },
    });
  }
  const payload = JSON.stringify({ stored_at: new Date().toISOString() });
  await defaultCache.put(
    key,
    new Response(payload, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
    }),
  );
  return new NextResponse(payload, {
    headers: { "x-probe": "MISS", "content-type": "application/json" },
  });
}
