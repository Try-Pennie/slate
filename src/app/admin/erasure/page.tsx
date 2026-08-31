import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { AppHeader } from "@/components/AppHeader";
import { ErasureWorklist } from "@/components/ErasureWorklist";
import { loadErasureWorklist } from "@/lib/snowflake/erasure-worklist-load";

export const dynamic = "force-dynamic";

/**
 * The operator worklist for pending Snowflake erasure purges (#1124).
 *
 * WHO MAY LOAD IT: a signed in ADMIN of the org, and nobody else. Two things this
 * page exposes make that the floor rather than a preference. It lists the audit
 * trail of people whose data has been erased (a hash of each address, plus the
 * bookings involved), and its controls trigger a destructive warehouse write. The
 * route those controls call, `POST /api/admin/erasure-purge`, enforces the same
 * bar independently: this page is not a gate the API relies on, and removing it
 * would not open the API.
 *
 * ORG SCOPING: the list holds only this admin's org's `pii.erasure` rows, so the
 * ids a per row control can send are its own org's. The trail wide control is
 * genuinely trail wide, which is what makes a missed purge fix itself, and the
 * screen says so in the sentence next to it rather than implying it matches the
 * list. Slate is single org today, so the two sets are the same in production.
 *
 * Everything below the guard is presentation over `auditSnowflakeErasures`'s own
 * residual measurement and that route. No erasure logic lives on this path.
 */
export default async function ErasureWorklistPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need an admin account to view data subject erasures.
      </main>
    );
  }

  // Never throws: a trail read failure comes back as its own state, because an
  // empty list here would read as "nothing is outstanding" (L10).
  const state = await loadErasureWorklist(me.org_id);

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
      <main className="mx-auto w-full min-w-0 max-w-5xl space-y-8 px-6 py-10 sm:px-8">
        <ErasureWorklist state={state} />
        <a href="/admin/settings" className="text-xs text-pennie-blue underline dark:text-pennie-sky">
          Back to settings
        </a>
      </main>
    </>
  );
}
