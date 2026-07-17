"use client";

import { useState } from "react";

import { AsyncListStates, useFetchList } from "@/components/AsyncList";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import type { BookingEventView } from "@/lib/booking/event-display";

/** The whole roster is Eastern (matches the server-side history formatting). */
const ROSTER_ZONE = "America/New_York";

const extractEvents = (json: unknown): BookingEventView[] =>
  (json as { events?: BookingEventView[] } | null)?.events ?? [];

/** "Fri, Jul 3, 10:03 AM" for the moment the event was recorded. */
function formatRecordedAt(iso: string): string {
  return `${formatSlotDay(iso, ROSTER_ZONE)}, ${formatSlotTime(iso, ROSTER_ZONE)}`;
}

/**
 * Per-booking reschedule/cancel/reassign history (#561). A manager opens it from
 * the recent-bookings row; the events (who/when/why + the time/agent change and
 * lead time, incl. #549 impersonation attribution) are fetched on demand from
 * /api/admin/bookings/[id]/history. Reuses the shared AsyncList so loading,
 * error, and empty are visibly distinct states, never a bare spinner.
 */
export default function BookingHistory({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = useState(false);
  const { items, loading, error, retry } = useFetchList(
    `/api/admin/bookings/${encodeURIComponent(bookingId)}/history`,
    open,
    extractEvents,
  );

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="min-h-9 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:border-fg/45"
      >
        {open ? "Hide history" : "History"}
      </button>

      {open && (
        <div className="mt-2 min-w-[20rem] max-w-md">
          <AsyncListStates
            loading={loading}
            error={error}
            isEmpty={items.length === 0}
            onRetry={retry}
            loadingLabel="Loading history"
            resultLabel={`${items.length} change${items.length === 1 ? "" : "s"}`}
            emptyLabel="No changes recorded"
            skeletonCount={2}
            skeletonClassName="h-12"
            containerClassName="space-y-2"
            emptyNode={<p className="text-xs text-fg-muted">No changes recorded for this booking.</p>}
          >
            <ol className="space-y-3">
              {items.map((e) => (
                <li key={e.id} className="border-l-2 border-border pl-3 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-fg">{e.actionLabel}</span>
                    <span className="text-fg-muted tabular-nums">{formatRecordedAt(e.at)}</span>
                  </div>
                  <div className="text-fg-muted">{e.who}</div>
                  <div className="mt-0.5 text-fg">{e.reason}</div>
                  {e.timeChange && (
                    <div className="mt-0.5 text-fg-muted">{e.timeChange}</div>
                  )}
                  {e.agentChange && (
                    <div className="mt-0.5 text-fg-muted">{e.agentChange}</div>
                  )}
                  {e.lead && <div className="mt-0.5 text-fg-muted">{e.lead}</div>}
                </li>
              ))}
            </ol>
          </AsyncListStates>
        </div>
      )}
    </div>
  );
}
