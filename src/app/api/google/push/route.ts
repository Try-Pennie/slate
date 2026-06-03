import { NextResponse, type NextRequest } from "next/server";
import { googleChannelToken } from "@/lib/env";
import { runIncrementalSync, userIdForChannel } from "@/lib/google/sync";

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
    const userId = await userIdForChannel(channelId);
    if (userId) {
      // Don't block Google's delivery on the sync.
      runIncrementalSync(userId).catch(() => {});
    }
  }

  return new NextResponse(null, { status: 200 });
}
