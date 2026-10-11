"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { btnSecondaryCls } from "@/components/ui/styles";
import type { DemotionMoveView, RevertRefusal } from "@/lib/booking/demotion-revert";

/**
 * The panel on a booking an automatic demotion reroute moved (#3615): what happened, and the
 * one way to undo it. Every sentence is built and tested in `demotion-revert.ts`; this holds the
 * markup and the request.
 *
 * It asks before it moves anything, in place, the way `ConfirmAction` does: the confirm takes
 * focus when it appears and Cancel returns it to the opener, so a keyboard user is never dropped
 * onto the page. Each outcome is said on this page (L608): done redraws the page, a refusal says
 * why in its own words, an advisor at their daily limit asks again before overriding it, and a
 * reply that never came says it cannot tell and redraws the page to show where the call is.
 */
export default function DemotionMoveBack({ bookingId, view }: { bookingId: string; view: DemotionMoveView }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "confirm" | "over-cap">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stalled = useStalledAfter(busy);
  const openerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);

  useEffect(() => {
    if (mode !== "idle") confirmRef.current?.focus();
    else if (returning.current) openerRef.current?.focus();
    returning.current = false;
  }, [mode]);

  if (view.state !== "can-move-back") {
    return (
      <div className="space-y-1 text-sm">
        <p>{view.summary}</p>
        {view.state === "cannot" && <p className="text-fg-muted">{view.reason}</p>}
      </div>
    );
  }

  function back() {
    returning.current = true;
    setError(null);
    setMode("idle");
  }

  async function moveBack(overrideCap: boolean) {
    if (view.state !== "can-move-back") return;
    setBusy(true);
    setError(null);
    try {
      const { ok, status, data } = await postJson<{ code?: string; reason?: RevertRefusal }>(
        `/api/admin/bookings/${bookingId}/move-back`,
        { overrideCap },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (ok) {
        router.refresh();
      } else if (data.code === "DAILY_CAP_EXCEEDED") {
        setMode("over-cap");
      } else {
        // Every other answer closes the question and says what happened instead. A refusal means
        // the call's state moved on since the page was drawn, so the page is redrawn too.
        setMode("idle");
        if (data.reason && view.refusals[data.reason]) {
          setError(view.refusals[data.reason]);
          router.refresh();
        } else if (status === 0) {
          setError("No answer came back, so Slate cannot tell whether the call moved. The page is being redrawn to show where it is now.");
          router.refresh();
        } else {
          setError("The call could not be moved back. Nothing changed; try again in a moment.");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <p>{view.summary}</p>
      {mode === "idle" ? (
        <button ref={openerRef} type="button" onClick={() => setMode("confirm")} className={btnSecondaryCls}>
          {view.buttonLabel}
        </button>
      ) : (
        <div className="space-y-2">
          <p role="alert">{mode === "over-cap" ? view.overCapText : view.confirmMessage}</p>
          <div className="flex flex-wrap gap-2">
            <button
              ref={confirmRef}
              type="button"
              disabled={busy}
              onClick={() => moveBack(mode === "over-cap")}
              className={btnSecondaryCls}
            >
              {busy ? "Moving back…" : mode === "over-cap" ? "Move back anyway" : view.confirmLabel}
            </button>
            <button type="button" disabled={busy} onClick={back} className={btnSecondaryCls}>
              {view.keepLabel}
            </button>
          </div>
        </div>
      )}
      {busy && stalled && !error && (
        <p role="status" className="text-xs text-fg-muted">
          Still working… this is taking longer than usual.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
