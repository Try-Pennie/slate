"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnSecondaryCls } from "@/components/ui/styles";

/**
 * Two-step confirm for declining a time-off request — declining rejects an
 * agent's real time off and DMs them, so a single misclick shouldn't do it.
 * Mirrors the inline confirm on the agent's Cancel control (RequestActions):
 * the Decline button is replaced by a Keep it / Yes, decline pair in a soft-rose
 * group. Lives inside the existing reject <form>, so the optional note submits
 * with it and SubmitButton can reflect the in-flight state.
 */

const ghost =
  "rounded-md px-3 py-1.5 text-sm font-semibold transition-colors";

export function DeclineConfirm({ agentName }: { agentName: string }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={btnSecondaryCls}
      >
        Decline
      </button>
    );
  }

  return (
    <span className="pn-confirm-enter flex items-center gap-1 rounded-lg bg-error/5 p-1">
      <span className="pl-2 pr-1 text-sm text-fg-muted">
        Decline {agentName}&apos;s request?
      </span>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className={`${ghost} text-fg-muted hover:bg-pennie-sky-soft hover:text-fg dark:hover:bg-accent/15`}
      >
        Keep it
      </button>
      <SubmitButton
        className={`${ghost} bg-error/10 text-error hover:bg-error/20`}
        pendingLabel="Declining…"
      >
        Yes, decline
      </SubmitButton>
    </span>
  );
}
