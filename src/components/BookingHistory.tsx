import type { BookingEventView } from "@/lib/booking/event-display";
import ViewerTime from "@/components/ViewerTime";

/**
 * Per-booking reschedule, cancel and reassign history (#561).
 *
 * RENDERED SERVER SIDE, and open (#1943). Dan: "don't hide history. there should
 * be no toggle there. leave it open like this all the time."
 *
 * It was a client component behind a toggle that fetched on first open. Since
 * the page around it is a server component and `listBookingHistory` is a server
 * function, taking the toggle away honestly meant taking the client fetch with
 * it: the loading skeleton, the error state and the retry all went too, and with
 * them one of only two client fetch sites in the whole app.
 *
 * `events` of `null` means the history could NOT be read, which is not the same
 * as a booking that has never changed. That distinction was what the shared
 * async states were carrying, and it has to survive server side or an unreadable
 * history renders as "no changes recorded" (L10).
 */
export default function BookingHistory({ events }: { events: BookingEventView[] | null }) {
  if (events === null) {
    return (
      <p className="text-xs text-error">
        The history could not be read, so no changes are listed. This is not a report that
        nothing has changed.
      </p>
    );
  }

  if (events.length === 0) {
    return <p className="text-xs text-fg-muted">No changes recorded for this booking.</p>;
  }

  return (
    <>
      {/* The order was an assumption the reader had to make, and with identical
          stamps there was nothing to infer it from (#1943). */}
      <p className="mb-2 text-xs text-fg-muted">
        {events.length} change{events.length === 1 ? "" : "s"}, newest first.
      </p>
      {/* ONE continuous rule, on the list, with the entries indented off it.
          Every entry used to draw its own 2px left border inside a spaced list,
          so the gap between entries left a break in it and what you saw was
          disconnected grey segments rather than a timeline. */}
      <ol className="space-y-3 border-l-2 border-border pl-3">
        {events.map((e) => (
          <li key={e.id} className="text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-fg">{e.actionLabel}</span>
              {/* SECONDS, because without them three events cannot be ordered
                  by eye (#1943): a run of reschedules genuinely lands inside one
                  minute. In the viewer's zone, labelled (#1916). */}
              <span className="text-fg-muted tabular-nums">
                <ViewerTime iso={e.at} seconds />
              </span>
            </div>
            <div className="text-fg-muted">{e.who}</div>
            <div className="mt-0.5 text-fg">{e.reason}</div>
            {e.timeChange && (
              <div className="mt-0.5 text-fg-muted tabular-nums">
                <ViewerTime iso={e.timeChange.from} /> &rarr; <ViewerTime iso={e.timeChange.to} />
              </div>
            )}
            {e.agentChange && <div className="mt-0.5 text-fg-muted">{e.agentChange}</div>}
            {e.lead && <div className="mt-0.5 text-fg-muted">{e.lead}</div>}
          </li>
        ))}
      </ol>
    </>
  );
}
