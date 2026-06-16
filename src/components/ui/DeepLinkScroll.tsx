"use client";

import { useEffect } from "react";

/**
 * When a manager arrives from a Slack "Review it here" deep link
 * (/admin/ooo?request=<id>), centre the matching card in view so the ring +
 * pulse highlight is seen, even if the request is far down the queue.
 */
export function DeepLinkScroll({ targetId }: { targetId: string | null }) {
  useEffect(() => {
    if (!targetId) return;
    document
      .getElementById(targetId)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [targetId]);
  return null;
}
