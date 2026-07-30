import { NextResponse, after, type NextRequest } from "next/server";
import { log } from "@/lib/log";
import { googleChannelToken } from "@/lib/env";
import { syncByChannel } from "@/lib/google/sync";

export const dynamic = "force-dynamic";

/**
 * Google Calendar push notifications land here. We verify the channel token,
 * then run an incremental sync for the owning agent so the cache reflects
 * externally-made calendar changes within seconds.
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-goog-channel-token");
  if (token !== googleChannelToken()) {
    return new NextResponse("forbidden", { status: 403 });
  }

  // The first ping after watch() just confirms the channel — nothing to sync.
  const state = req.headers.get("x-goog-resource-state");
  if (state === "sync") return new NextResponse(null, { status: 200 });

  const channelId = req.headers.get("x-goog-channel-id");
  if (channelId) {
    // Sync just the pinged calendar; don't block Google's delivery on it.
    // after() keeps the Worker alive until the sync settles. A bare
    // fire-and-forget promise is cut off once the response is sent on the
    // Cloudflare runtime, so the sync could silently never land (#191).
    after(() =>
      syncByChannel(channelId).catch((err) =>
        // Google will not redeliver this notification, so a lost sync means the
        // calendar change waits for the 1-min backstop with no trace of the miss.
        log.error("google-push", { msg: "push-triggered sync failed", channel_id: channelId }, err),
      ),
    );
  }

  return new NextResponse(null, { status: 200 });
}
