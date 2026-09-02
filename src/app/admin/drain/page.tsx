import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DRAIN_ALERT_AFTER } from "@/lib/booking/drain-backoff";
import {
  normalizeOutboxRow,
  normalizeReservationRow,
  summarizeStuck,
  type StuckRow,
} from "@/lib/booking/stuck-drain";
import { AppHeader } from "@/components/AppHeader";
import { Pill } from "@/components/ui/Pill";
import { cardCls, proseCls } from "@/components/ui/styles";
import type { BookingOutbox, BookingReservation } from "@/lib/db/types";
import { PageShell } from "@/components/ui/PageShell";

export const dynamic = "force-dynamic";

// A stuck row can persist for a long time, so show absolute local timestamps
// rather than a relative age (which would need Date.now() in render and trip the
// react-hooks purity rule; see the OOO page).
function fmt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function StuckDrainPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need an admin account to view stuck deliveries.
      </main>
    );
  }

  const db = supabaseAdmin();
  const [outboxRes, reservationRes] = await Promise.all([
    db
      // cap-safe: only rows past the alert threshold and still pending; a bounded
      // page (200 wedged rows is itself an emergency, not normal volume).
      .from("booking_outbox")
      .select("*")
      .eq("status", "pending")
      .gte("attempts", DRAIN_ALERT_AFTER)
      .order("attempts", { ascending: false })
      .limit(200),
    db
      // cap-safe: same bound as above, over the reservation (crash-recovered create) drain.
      .from("booking_reservations")
      .select("*")
      .eq("status", "pending")
      .gte("attempts", DRAIN_ALERT_AFTER)
      .order("attempts", { ascending: false })
      .limit(200),
  ]);

  // A read error here must not look like "nothing is stuck" (a false all-clear).
  // Surface it loudly rather than rendering an empty, reassuring table.
  const readError = outboxRes.error?.message ?? reservationRes.error?.message ?? null;

  const rows: StuckRow[] = [
    ...((outboxRes.data ?? []) as BookingOutbox[]).map(normalizeOutboxRow),
    ...((reservationRes.data ?? []) as BookingReservation[]).map(normalizeReservationRow),
  ].sort((a, b) => b.attempts - a.attempts);
  const summary = summarizeStuck(rows);

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        active="admin"
        themePreference={me.theme_preference}
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <PageShell>
        <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          <p className="pn-eyebrow text-pennie-sky">Diagnostics</p>
          <h1 className="pn-h2 mt-2 text-pennie-beige">
            {summary.total === 0
              ? "Nothing wedged."
              : `${summary.total} stuck ${summary.total === 1 ? "delivery" : "deliveries"}`}
          </h1>
          <p className={`mt-2 text-pennie-beige/75 ${proseCls}`}>
            Rows whose drain has failed at least {DRAIN_ALERT_AFTER} times and is
            backing off.
            {summary.gaveUp > 0 && (
              <>
                {" "}
                <span className="font-semibold text-pennie-beige">
                  {summary.gaveUp}
                </span>{" "}
                have hit the give-up cap and need a human.
              </>
            )}
          </p>
        </section>

        {readError && (
          <div role="alert" className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error">
            Could not read the drain tables: {readError}. This list may be incomplete.
          </div>
        )}

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-fg-muted">
            No deliveries are stuck. Failed side effects and crash-recovered
            creates show up here once they cross the alert threshold.
          </p>
        ) : (
          <section className={cardCls}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th className="py-1 pr-3 font-semibold">Kind</th>
                    <th className="py-1 pr-3 font-semibold">Action</th>
                    <th className="py-1 pr-3 font-semibold">Reference</th>
                    <th className="py-1 pr-3 font-semibold">Attempts</th>
                    <th className="py-1 pr-3 font-semibold">Next retry</th>
                    <th className="py-1 pr-3 font-semibold">Last error</th>
                    <th className="py-1 font-semibold">Last tried</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}-${r.id}`} className="border-t border-border align-top">
                      <td className="py-2 pr-3">
                        <Pill variant="outline">{r.kind}</Pill>
                      </td>
                      <td className="py-2 pr-3">{r.action}</td>
                      <td className="py-2 pr-3 font-mono text-xs break-all">
                        {r.ref ?? <span className="text-fg-muted">none</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {r.gaveUp ? (
                          <Pill variant="status-error">{r.attempts} · gave up</Pill>
                        ) : (
                          <span className="tabular-nums">{r.attempts}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-fg-muted">
                        {r.gaveUp ? "not retrying" : r.nextAttemptAt ? fmt(r.nextAttemptAt) : "now"}
                      </td>
                      <td className="py-2 pr-3 text-fg-muted">
                        {r.lastError ?? <span className="italic">no error recorded</span>}
                      </td>
                      <td className="py-2 whitespace-nowrap tabular-nums text-fg-muted">
                        {fmt(r.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <a href="/admin/settings" className="text-xs text-pennie-blue underline dark:text-pennie-sky">
          Back to settings
        </a>
      </PageShell>
    </>
  );
}
