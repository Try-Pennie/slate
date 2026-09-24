"use client";

import { useState, type FormEvent } from "react";

import { AsyncListStates, useFetchList } from "@/components/AsyncList";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { bookingDetailHref } from "@/lib/booking/detail";
import { SEARCH_LIMIT, type BookingSearchRow } from "@/lib/booking/search";
import { TestMark } from "@/components/TestModeBand";

/** The whole roster is Eastern (matches the server-side history formatting). */
const ROSTER_ZONE = "America/New_York";

const extractBookings = (json: unknown): BookingSearchRow[] =>
  (json as { bookings?: BookingSearchRow[] } | null)?.bookings ?? [];

function formatWhen(iso: string): string {
  return `${formatSlotDay(iso, ROSTER_ZONE)}, ${formatSlotTime(iso, ROSTER_ZONE)}`;
}

/**
 * Look up ANY booking and view its history (#901), for bookings older than the
 * recent-25 table (#561 only surfaces those). A manager searches by attendee
 * email/name/phone or booking id; each match carries the same History toggle.
 * Reuses the shared AsyncList so loading, error, and empty stay distinct.
 */
export default function BookingLookup() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { items, loading, error, retry } = useFetchList(
    submitted ? `/api/admin/bookings/search?q=${encodeURIComponent(submitted)}` : null,
    submitted !== "",
    extractBookings,
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(input.trim());
  }

  return (
    <div>
      {/* unsaved-ok: a search box holds a view, not work (#2076). */}
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Attendee email, name, phone, or booking id"
          aria-label="Search bookings"
          className="min-h-9 flex-1 rounded-md border border-border bg-surface px-3 py-1 text-sm text-fg placeholder:text-fg-muted"
        />
        <button
          type="submit"
          className="min-h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-fg hover:border-fg/45"
        >
          Search
        </button>
      </form>

      {submitted && (
        <div className="mt-3">
          <AsyncListStates
            loading={loading}
            error={error}
            isEmpty={items.length === 0}
            onRetry={retry}
            loadingLabel="Searching bookings"
            resultLabel={`${items.length} booking${items.length === 1 ? "" : "s"} found`}
            emptyLabel="No bookings found"
            skeletonCount={3}
            skeletonClassName="h-10"
            containerClassName="space-y-2"
            emptyNode={<p className="text-sm text-fg-muted">No bookings found for that search.</p>}
          >
            {items.length >= SEARCH_LIMIT && (
              <p className="mb-2 text-xs text-fg-muted">
                Showing the first {SEARCH_LIMIT} matches. If you don&apos;t see the booking,
                narrow your search.
              </p>
            )}
            <ul className="space-y-2">
              {items.map((b) => (
                <li key={b.id} className="border-t border-border">
                  <a
                    href={bookingDetailHref(b.id)}
                    className="flex flex-wrap items-baseline gap-x-2 rounded-md px-1 py-2 text-sm hover:bg-fg/5"
                  >
                    {/* #2660: a booking on the public test bucket is a stranger's
                        test. It stays findable (a manager cancelling one is how the
                        issue's own evidence was gathered) and is marked, in the one
                        treatment reserved for that, so it is never read as a lead. */}
                    {b.isTest && <TestMark />}
                    <span className="font-semibold text-fg">
                      {b.attendeeName || b.attendeeEmail || b.attendeePhone || "(no name)"}
                    </span>
                    <span className="text-fg-muted tabular-nums">{formatWhen(b.startsAt)}</span>
                    <span className="text-fg-muted">{b.agentName}</span>
                    <span className="capitalize text-fg-muted">{b.status}</span>
                  </a>
                </li>
              ))}
            </ul>
          </AsyncListStates>
        </div>
      )}
    </div>
  );
}
