import { NextResponse, after, type NextRequest } from "next/server";
import { log } from "@/lib/log";
import { timingSafeEqual } from "@/lib/bearer-auth";
import { googleChannelToken } from "@/lib/env";
import { syncByChannel } from "@/lib/google/sync";

export const dynamic = "force-dynamic";

/**
 * Google Calendar push notifications land here. We verify the channel token,
 * then run an incremental sync for the owning agent so the cache reflects
 * externally-made calendar changes within seconds.
 */
export async function POST(req: NextRequest) {
  // #1046: constant time, through the one shared verifier every other machine
  // endpoint uses (#594). A plain `!==` short circuits on the first differing
  // character, so the response time leaks how much of the token a guess got right.
  // The null check comes first because the verifier takes two strings and a thrown
  // TypeError would answer 500, which Google reads as retriable.
  const token = req.headers.get("x-goog-channel-token");
  if (!token || !timingSafeEqual(token, googleChannelToken())) {
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
    after(() => {
      const startedAt = Date.now();
      return syncByChannel(channelId).then(
        // #2922: one line per push whose work FINISHED. Cloudflare cancels post
        // response work at its own limit and a cancelled job can write nothing, so
        // the completed side is what can be counted, against Cloudflare's
        // "waitUntil() tasks did not complete" warnings on the same route. Wall
        // time, which on Workers advances only across I/O; this work is almost all
        // I/O, so it reads close to the real duration.
        (outcome) =>
          log.info("google-push", {
            msg: "push work finished",
            channel_id: channelId,
            outcome,
            ms: Date.now() - startedAt,
          }),
        (err) =>
          // Google will not redeliver this notification, so a lost sync means the
          // calendar change waits for the 1-min backstop with no trace of the miss.
          log.error("google-push", { msg: "push-triggered sync failed", channel_id: channelId }, err),
      );
    });
  }

  return new NextResponse(null, { status: 200 });
}
