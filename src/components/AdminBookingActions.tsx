"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  validateReason,
} from "@/lib/booking/core";
import ReasonPicker from "@/components/ReasonPicker";

/**
 * Internal admin reschedule/cancel for a single booking (#326). Staff act on a
 * booking from the recent-bookings list; both actions REQUIRE a reason (recorded
 * with initiator='admin'). Reuses the same mandatory ReasonPicker as the customer
 * manage-link and the admin endpoints' server-side validation.
 */
export default function AdminBookingActions({
  bookingId,
  bucketCode,
  status,
}: {
  bookingId: string;
  bucketCode: string | null;
  status: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "cancel" | "reschedule">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonDetail, setReasonDetail] = useState("");

  // Only confirmed/rescheduled bookings can be changed.
  if (status === "cancelled" || status === "completed") {
    return (
      <span className="text-fg-muted capitalize">{status}</span>
    );
  }

  const action = mode === "reschedule" ? "reschedule" : "cancel";
  const reasonValid = validateReason(action, { code: reasonCode, detail: reasonDetail }).ok;

  function reset() {
    setMode(null);
    setError(null);
    setReasonCode("");
    setReasonDetail("");
    setSlots([]);
  }

  async function openReschedule() {
    setMode("reschedule");
    setError(null);
    setReasonCode("");
    setReasonDetail("");
    if (!bucketCode) return;
    const r = await fetch(`/api/availability?bucket=${encodeURIComponent(bucketCode)}`, {
      cache: "no-store",
    });
    const d = r.ok ? await r.json() : { slots: [] };
    setSlots(d.slots ?? []);
  }

  async function doCancel() {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/admin/bookings/${bookingId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reasonCode, reasonDetail: reasonDetail || undefined }),
    });
    if (r.ok) {
      reset();
      router.refresh();
    } else {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not cancel. Please try again.");
    }
    setBusy(false);
  }

  async function doReschedule(start: string) {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/admin/bookings/${bookingId}/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start, reason: reasonCode, reasonDetail: reasonDetail || undefined }),
    });
    if (r.ok) {
      reset();
      router.refresh();
    } else {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not reschedule. Please try again.");
    }
    setBusy(false);
  }

  if (mode === null) {
    return (
      <div className="flex gap-2">
        <button
          onClick={openReschedule}
          className="min-h-9 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:border-fg/45"
        >
          Reschedule
        </button>
        <button
          onClick={() => setMode("cancel")}
          className="min-h-9 rounded-md border border-[var(--error)] px-2 py-1 text-xs font-semibold text-[var(--error)] hover:bg-[rgba(196,61,61,0.06)]"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <ReasonPicker
        legend={mode === "cancel" ? "Why are you cancelling?" : "Why are you rescheduling?"}
        options={mode === "cancel" ? CANCEL_REASONS : RESCHEDULE_REASONS}
        code={reasonCode}
        detail={reasonDetail}
        onCode={setReasonCode}
        onDetail={setReasonDetail}
        idPrefix={`admin-${mode}-${bookingId}`}
      />

      {mode === "cancel" ? (
        <div className="mt-3 flex gap-2">
          <button
            onClick={doCancel}
            disabled={busy || !reasonValid}
            className="min-h-9 rounded-md bg-[var(--error)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Cancelling…" : "Confirm cancel"}
          </button>
          <button onClick={reset} disabled={busy} className="min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
            Back
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="mb-2 text-xs font-semibold text-fg">
            {reasonValid ? "Pick a new time" : "Choose a reason above, then pick a new time"}
          </p>
          <div className="grid grid-cols-2 gap-1">
            {slots.slice(0, 12).map((iso) => (
              <button
                key={iso}
                disabled={busy || !reasonValid}
                onClick={() => doReschedule(iso)}
                className="min-h-9 rounded-md border border-border bg-surface px-1 py-1 text-xs tabular-nums text-fg hover:border-fg/45 disabled:opacity-60"
              >
                {new Date(iso).toLocaleString("en-US", {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </button>
            ))}
            {slots.length === 0 && (
              <p className="col-span-2 text-xs text-fg-muted">No open times.</p>
            )}
          </div>
          <button onClick={reset} disabled={busy} className="mt-2 min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg">
            Back
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
