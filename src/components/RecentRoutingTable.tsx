import { bookingDetailHref } from "@/lib/booking/detail";
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
  const nameOf = (id: string | null) =>
    id ? (agentName.get(id) ?? id.slice(0, 8)) : "unassigned";

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
            <th className="py-1 pr-3 font-semibold">Trace</th>
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
                  {new Date(b.starts_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </td>
                <td className="py-1.5 pr-3">{lead}</td>
                <td className="py-1.5 pr-3 text-fg-muted">{t?.bucket_code ?? "?"}</td>
                <td className="py-1.5 pr-3 font-semibold">{nameOf(b.assigned_user_id)}</td>
                <td className="py-1.5 text-fg-muted">
                  {t ? (
                    <div className="space-y-0.5">
                      <div>
                        {t.considered.length} considered
                        {t.fallback_applied ? " · fallback used" : ""}
                      </div>
                      {(t.reassignments ?? []).map((r, i) => (
                        <div key={i} className="text-pennie-blue dark:text-pennie-sky">
                          reassigned {nameOf(r.from)} → {nameOf(r.to)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    "no trace"
                  )}
                </td>
                <td className="py-1.5 align-top">
                  <a
                    href={bookingDetailHref(b.id)}
                    className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-2 py-1 text-fg hover:border-fg/45"
                  >
                    Open
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
