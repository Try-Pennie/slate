"use client";

import { useEffect, useRef } from "react";
import { endDroppedImpersonation } from "@/app/admin/actions";

/**
 * Auto-clears a silently-dropped "view as" cookie in the background (#652). Fires
 * the server action once on mount and renders nothing. Calling the action
 * directly (not via a form) means no page refresh, so the sibling "session ended"
 * notice stays visible while the stale cookie is deleted behind it. The notice
 * also ships a no-JS manual button, and the cookie self-expires within the #653
 * max lifetime, so this is a progressive enhancement rather than the only path.
 */
export function ImpersonationDropAutoClear({
  reason,
}: {
  reason: "expired" | "unavailable";
}) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void endDroppedImpersonation(reason);
  }, [reason]);
  return null;
}
