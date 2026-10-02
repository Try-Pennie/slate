import { OpenBookingLink } from "@/components/OpenBookingLink";
import ViewerTime from "@/components/ViewerTime";
import { bucketHeading, bucketShownAs } from "@/lib/availability/pool-label";
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
> & {
  routing_trace: RoutingTrace | null;
  /** The booking's bucket, joined on the read. Its name is what a manager reads
   *  for a bucket outside the routing matrix, which has no pool name. */
  buckets?: { name?: string | null } | null;
};

type RosterUser = { id: string; name: string | null; email: string };

/**
 * The admin "Recent routing" table (#905), extracted from the admin page so it
 * is unit-testable on its own. Read-only: each row links to the per-booking
 * detail page (#900) where the actions and history live. Behaviour is identical
 * to the markup it replaced, including the id-prefix name fallback.
 *
 * `showCodes` (2026-10-02): admins read the bucket code, managers read the pool
 * in words (`bucketShownAs`). Required, so every caller decides it.
 */
export function RecentRoutingTable({
  rows,
  users,
  showCodes,
}: {
  rows: RecentRoutingRow[];
  users: RosterUser[];
  showCodes: boolean;
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
            <th className="py-1 pr-3 font-semibold">{bucketHeading(showCodes)}</th>
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
                <td className="py-1.5 pr-3 text-fg-muted">
                  {bucketShownAs(t?.bucket_code, { showCodes, storedName: b.buckets?.name }) ?? "?"}
                </td>
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
                  <OpenBookingLink bookingId={b.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
