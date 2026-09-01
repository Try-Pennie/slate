import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  normalizeMix,
  excludedTestTrafficNote,
  type OutcomeMix,
  type RawMix,
} from "@/lib/monitor/booking-api-outcome";
import { AppHeader } from "@/components/AppHeader";
import { cardCls } from "@/components/ui/styles";

export const dynamic = "force-dynamic";

const ROSTER_ZONE = "America/New_York";

// Module scope so the DateTime.now() call doesn't trip react-hooks/purity in render.
function sinceIso(days: number): string {
  return DateTime.now().setZone(ROSTER_ZONE).minus({ days }).toISODate() ?? "";
}

const OUTCOME_LABEL: Record<string, string> = {
  created: "Created",
  rescheduled: "Rescheduled",
  deduped: "Deduped",
  confirm_required: "Confirm required",
  error: "Error",
};

/** A window's mix: the outcome bars plus, when present, the error-code breakdown. */
function Window({ title, mix }: { title: string; mix: OutcomeMix }) {
  return (
    <section className={cardCls}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-fg-muted tabular-nums">
          {mix.total} {mix.total === 1 ? "call" : "calls"}
        </span>
      </div>
      {/* #1616: this panel counts CUSTOMER attempts only, matching the failure
          rate page that points readers here. Hiding the smoke canary silently
          would make a quiet week and an excluded canary pass render the same
          number, so what was left out is stated either way, and an unreadable
          count says so rather than showing zero. */}
      <p className="mt-1 text-xs text-fg-muted">{excludedTestTrafficNote(mix.testTotal)}</p>
      {mix.total === 0 ? (
        <p className="mt-3 text-sm text-fg-muted">No direct booking API calls in this window.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {mix.outcomes.map((o) => (
            <li key={o.outcome} className="grid grid-cols-[8.5rem_1fr_3.5rem] items-center gap-3 text-sm">
              <span className="text-fg">{OUTCOME_LABEL[o.outcome] ?? o.outcome}</span>
              <span className="h-2 overflow-hidden rounded-full bg-bg-alt dark:bg-surface" aria-hidden="true">
                <span
                  className={`block h-full rounded-full ${o.outcome === "error" ? "bg-[var(--error)]" : "bg-pennie-sky"}`}
                  style={{ width: `${o.pct}%` }}
                />
              </span>
              <span className="text-right tabular-nums text-fg-muted">
                {o.count} <span className="text-xs">({o.pct}%)</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {mix.errors.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-fg-muted">Errors by code</h3>
          <ul className="mt-2 space-y-1">
            {mix.errors.map((e) => (
              <li key={e.code} className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs">{e.code}</span>
                <span className="tabular-nums text-fg-muted">{e.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default async function BookingOutcomesPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need an admin account to view booking API outcomes.
      </main>
    );
  }

  const db = supabaseAdmin();
  // p_include_test:false (#1616) so the panel measures the same population the
  // failure-rate page does. Passed explicitly, not left to the RPC's default, so
  // the decision is readable here rather than only in the database.
  const [weekRes, monthRes] = await Promise.all([
    db.rpc("booking_api_outcome_mix", { p_since: sinceIso(7), p_include_test: false }),
    db.rpc("booking_api_outcome_mix", { p_since: sinceIso(30), p_include_test: false }),
  ]);
  // A read error must not read as "no traffic" (a false all-clear); surface it.
  const readError = weekRes.error?.message ?? monthRes.error?.message ?? null;
  const week = normalizeMix(weekRes.data as RawMix | null);
  const month = normalizeMix(monthRes.data as RawMix | null);

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
      <main id="main" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-6 py-10 sm:px-8">
        <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          <p className="pn-eyebrow text-pennie-sky">Diagnostics</p>
          <h1 className="pn-h2 mt-2 text-pennie-beige">Booking API outcomes</h1>
          <p className="mt-2 text-pennie-beige/75">
            The mix of direct booking API results: whether person-dedupe,
            cross-bucket moves, and no-eligible-agents are behaving. Customer
            attempts only, so it matches the failure rate check; smoke canary
            calls are counted out separately below. Visibility only, not an alert.
          </p>
        </section>

        {readError && (
          <div role="alert" className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error">
            Could not read the outcome tally: {readError}. These numbers may be incomplete.
          </div>
        )}

        <Window title="Last 7 days" mix={week} />
        <Window title="Last 30 days" mix={month} />

        <a href="/admin/settings" className="text-xs text-pennie-blue underline dark:text-pennie-sky">
          Back to settings
        </a>
      </main>
    </>
  );
}
