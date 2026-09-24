import { bookingDetailHref } from "@/lib/booking/detail";
import ViewerTime from "@/components/ViewerTime";
import type { Booking, RoutingTrace } from "@/lib/db/types";

/** One recent booking + how it routed (the admin trace viewer's row). */
export type RecentRoutingRow = Pick<
  Booking,
  | "id"
  | "attendee_name"
  | "attendee_email"
  | "attendee_phone"
  | "starts_at"
  | "assigned_user_id"
  | "status"
> & { routing_trace: RoutingTrace | null };

type RosterUser = { id: string; name: string | null; email: string };

/**
 * The admin "Recent routing" table (#905), extracted from the admin page so it
 * is unit-testable on its own. Read-only: each row links to the per-booking
 * detail page (#900) where the actions and history live. Behaviour is identical
 * to the markup it replaced, including the id-prefix name fallback.
 */
export function RecentRoutingTable({
  rows,
  users,
}: {
  rows: RecentRoutingRow[];
  users: RosterUser[];
}) {
  const agentName = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  /**
   * An agent's name, or a statement that this row could not be named (#1914).
   *
   * It used to fall back to `id.slice(0, 8)`, which is worse than saying
   * nothing. The smoke agents carry deliberately patterned ids, so two DIFFERENT
   * agents both truncated to `c0000000` and a real reassignment rendered
   * "reassigned c0000000 to c0000000", which reads as a no operation. On the real
   * roster the ids are random, so it would not collide, and it would still put
   * eight hex characters where a reader expects a name.
   *
   * An unresolved id is a DETECTION that the roster this table was handed is
   * missing somebody, not a name (L67), so it says so rather than rendering as
   * data.
   */
  const nameOf = (id: string | null) => {
    if (!id) return "unassigned";
    return agentName.get(id) ?? "not in the roster";
  };

  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">No bookings yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-fg-muted">
          <tr>
            <th className="py-1 pr-3 font-semibold">When</th>
            <th className="py-1 pr-3 font-semibold">Lead</th>
            <th className="py-1 pr-3 font-semibold">Bucket</th>
            <th className="py-1 pr-3 font-semibold">Routed to</th>
            {/* #1914: "Trace" said nothing about what the cell holds. The
                parts stay in one cell because they are one decision, and each is
                now a statement rather than a fragment. */}
            <th className="py-1 pr-3 font-semibold">How it routed</th>
            <th className="py-1 font-semibold">
              <span className="sr-only">Open booking</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const t = b.routing_trace;
            const lead =
              b.attendee_name || b.attendee_email || b.attendee_phone || "(none)";
            return (
              <tr key={b.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                  {/* #1916: the viewer's zone, labelled, like every other
                      booking time on a staff surface. */}
                  <ViewerTime iso={b.starts_at} />
                </td>
                <td className="py-1.5 pr-3">{lead}</td>
                <td className="py-1.5 pr-3 text-fg-muted">{t?.bucket_code ?? "?"}</td>
                <td className="py-1.5 pr-3 font-semibold">{nameOf(b.assigned_user_id)}</td>
                <td className="py-1.5 text-fg-muted">
                  {t ? (
                    <div className="space-y-0.5">
                      <div>
                        {t.considered.length} agent{t.considered.length === 1 ? "" : "s"} considered
                      </div>
                      {t.fallback_applied && <div>Fallback used</div>}
                      {/* #1914: NOT blue. Blue text in a table reads as a link,
                          and this was not one, so it invited a click that did
                          nothing; it was also colour as the only signal, which
                          the design system's own rule forbids. The word
                          "Reassigned" carries the meaning, and the row's Open
                          link already goes to the booking where the reassignment
                          history lives, so a second link to the same place would
                          be the duplication rather than the fix. */}
                      {(t.reassignments ?? []).map((r, i) => (
                        <div key={i}>
                          Reassigned from {nameOf(r.from)} to {nameOf(r.to)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    "no trace"
                  )}
                </td>
                <td className="py-1.5 align-top">
                  {/* #1914: a new tab. This is a scan and dig surface, and
                      losing your place in a list of 25 to look at one booking is
                      the complaint. The sr-only half is not optional: a link that
                      takes over a new window without saying so is a surprise to
                      a screen reader user, who has no visual cue that anything
                      moved. */}
                  <a
                    href={bookingDetailHref(b.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-2 py-1 text-fg hover:border-fg/45"
                  >
                    Open
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
