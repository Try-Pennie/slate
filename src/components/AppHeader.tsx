import { AccountMenu } from "@/components/AccountMenu";
import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { HeaderNav, type HeaderTab } from "@/components/HeaderNav";
import { PAGE_WIDTHS } from "@/components/ui/PageShell";
import { oooOnlyFor } from "@/lib/env";
import {
  atLeast,
  canManageAgents,
  canModerateAllOoo,
  isRole,
} from "@/lib/auth/roles";
import { getImpersonationView } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { calendarHeaderStatus } from "@/lib/calendar/header-status";
import { log } from "@/lib/log";
import { stopImpersonation } from "@/app/admin/actions";
import { ImpersonationDropNotice } from "@/components/ImpersonationDropNotice";
import type { ThemePreference } from "@/lib/db/types";

// Module scope so the Date.now() call doesn't trip react-hooks/purity in render.
function hasLiveWatch(rows: { watch_expiration: string | null }[]): boolean {
  const now = Date.now();
  return rows.some(
    (r) => r.watch_expiration && Date.parse(r.watch_expiration) > now,
  );
}

/**
 * Shared branded header for the internal pages (/admin, /me).
 * Presentation-only: the page passes `email`/`role` down as props; no auth,
 * session, or data access happens here. Beige bar with a hairline bottom
 * border so the beige page dominates (80/15/5). The charcoal wordmark shows
 * on light; the cream wordmark swaps in on dark (display:none removes the
 * hidden one from the accessibility tree).
 */

export async function AppHeader({
  email,
  role,
  themePreference = "system",
  userId,
  orgId,
  bookable,
  avatarUrl,
}: {
  email: string;
  role?: string;
  themePreference?: ThemePreference;
  userId?: string;
  orgId?: string;
  bookable?: boolean;
  avatarUrl?: string | null;
}) {
  // The approval queue is a manager surface; agents manage their own time off
  // from /me, so they don't get the tab.
  const r = role ?? "";
  const oooOnly = oooOnlyFor(role);
  // Approval queue: managers and up. Agent roster: same, but hidden in the
  // OOO-only phase (so effectively admins+ until scheduling goes live).
  const showTimeOff = isRole(r) && atLeast(r, "manager");
  const showAdmin = !oooOnly && isRole(r) && canManageAgents(r);
  // Agents in OOO-only mode have a single page ("My Requests"); everyone else
  // keeps the "My Availability" label since they also have other tabs.
  const meLabel = oooOnly && r === "agent" ? "My Requests" : "My Availability";
  // Persistent banner so an impersonating admin always knows + can get out, plus
  // a one-time notice when a "view as" session was silently dropped (#652).
  const impersonation = await getImpersonationView();

  // Google Calendar sync status (#87). A live push-watch means real-time sync,
  // but a watch lapses and auto-renews on the cron and the 1-min backstop syncs
  // regardless, so "no live watch" is NOT the urgent case. Only a bookable agent
  // with NO calendar row at all (we can't sync them) gets the loud banner; a
  // lapsed watch with a row is "degraded". calendarHeaderStatus owns that call.
  // #1847: the calendar read and the staff-id read are independent of each other,
  // so they are issued TOGETHER rather than one after the other. Measured: this
  // header ran three reads in a strict chain, which on a full page load is a
  // serial prefix in front of the page. It is NOT on the client navigation path,
  // because Next reuses this layout between console pages, so the saving is on a
  // first visit or a refresh rather than on every click. Measured before building
  // rather than assumed, and the issue is corrected to say so.
  //
  // The pending count still waits for the staff ids, because it filters on them.
  const wantsCalendar = Boolean(userId) && !oooOnly;
  const wantsBadge = showTimeOff && Boolean(userId) && Boolean(orgId);
  const [calendarRows, staffRows] = await Promise.all([
    wantsCalendar
      ? // error-ok: a failed read leaves `checked: false`, which is the "we did
        // not look" state calendarHeaderStatus already models, and the banner
        // stays silent rather than claiming a calendar is broken. The every
        // minute sync lane is what actually reports a broken calendar.
        supabaseAdmin()
          .from("agent_calendars")
          .select("watch_expiration")
          .eq("user_id", userId!)
          .then((r) => r.data as { watch_expiration: string | null }[] | null)
      : Promise.resolve(null),
    wantsBadge
      ? // Exclude requests authored by admins/super admins, mirroring the Team
        // Requests page, so test/operator requests can't inflate the badge.
        // error-ok: an unreadable staff list means the exclusion is not applied;
        // the count below consults its own error and hides the badge either way.
        supabaseAdmin()
          .from("users")
          .select("id")
          .eq("org_id", orgId!)
          .in("role", ["admin", "super_admin"])
          .then((r) => r.data as { id: string }[] | null)
      : Promise.resolve(null),
  ]);

  let calendar = calendarHeaderStatus({
    checked: false,
    bookable: bookable === true,
    hasCalendars: false,
    hasLiveWatch: false,
  });
  if (wantsCalendar) {
    const rows = calendarRows ?? [];
    calendar = calendarHeaderStatus({
      checked: true,
      bookable: bookable === true,
      hasCalendars: rows.length > 0,
      hasLiveWatch: hasLiveWatch(rows),
    });
  }

  // Pending-OOO count on the Team Requests tab, so approvals don't depend on a
  // manager catching the Slack DM or the daily digest. Scoped to the manager's
  // own reports; team leads and up (canModerateAllOoo) see the whole org. Needs
  // org_id for the org-wide scope, so it's a no-op without the orgId prop.
  let pendingOoo = 0;
  if (wantsBadge) {
    const staffIds = (staffRows ?? []).map((u) => u.id);

    let q = supabaseAdmin()
      .from("ooo_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId!)
      .eq("status", "pending");
    if (staffIds.length > 0) {
      q = q.not("user_id", "in", `(${staffIds.join(",")})`);
    }
    // showTimeOff already implies isRole(r); the guard just narrows the type.
    if (isRole(r) && !canModerateAllOoo(r)) q = q.eq("manager_id", userId!);
    // #1165: consult `error`. A failed count came back null and `?? 0` hid the
    // badge, which is exactly what an empty queue looks like, so a broken read
    // presented as "nothing waiting for you". The header still renders (throwing
    // here would take down every admin page over a nudge, and the Team Requests
    // page is the source of truth one click away), but the failure is logged
    // rather than passing as a healthy zero.
    const { count, error } = await q;
    if (error) {
      log.warn("app-header", {
        msg: "pending time-off count read failed; badge hidden",
        org_id: orgId,
        err: error.message,
      });
    }
    pendingOoo = count ?? 0;
  }

  // Which tab is CURRENT is decided by HeaderNav from the path, not here: since
  // #1748 the admin console renders this header once from its layout, which wraps
  // /admin and /admin/ooo alike, so there is no page left in a position to say.
  const tabs: HeaderTab[] = [
    ...(showAdmin ? [{ href: "/admin", label: "Admin" }] : []),
    { href: "/me", label: meLabel },
    ...(showTimeOff
      ? [{ href: "/admin/ooo", label: "Team Requests", badge: pendingOoo }]
      : []),
  ];
  return (
    <>
    {/* #1054: the first focusable thing on every internal page, so a keyboard or
        switch user can jump the branded bar and the nav rather than walking them on
        every load (WCAG 2.4.1). It is here rather than in each page because there is
        one header. The TARGET is on the other side of that split: since #1745 it
        lives in PageShell, which every internal page renders, and
        scripts/test-skip-link-target.ts checks both halves (the shell really
        provides a focusable target, and every page really reaches the shell), since
        a skip link pointing at nothing is a control that appears to work and moves
        focus nowhere. */}
    <a href="#main" className="pn-skip-link">
      Skip to content
    </a>
    {impersonation.status === "active" && (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-pennie-navy px-4 py-2 text-center text-sm text-pennie-beige">
        <span>
          Viewing as{" "}
          <strong>{impersonation.target.name ?? impersonation.target.email}</strong>{" "}
          ({impersonation.target.role}). Actions you take happen as them.
        </span>
        <SaveForm action={stopImpersonation} name="stop-impersonation" onStale="reload">
          <SubmitButton
            className="pn-btn pn-btn--small pn-btn--primary"
            pendingLabel="Returning to your own view"
          >
            Stop viewing as them
          </SubmitButton>
        </SaveForm>
      </div>
    )}
    {impersonation.status === "dropped" && (
      <ImpersonationDropNotice reason={impersonation.reason} />
    )}
    {calendar.urgent && (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-[var(--error)] px-4 py-2 text-center text-sm text-white">
        <span>
          Your Google Calendar isn&apos;t syncing, so your availability can be
          wrong and you may get double-booked.
        </span>
        <a
          href="/login"
          className="rounded-md bg-white px-3 py-1.5 font-semibold text-error"
        >
          Connect Google
        </a>
      </div>
    )}
    <header className="sticky top-0 z-30 border-b border-border bg-bg">
      {/* #1745: the same cap the page content uses, so the wordmark and the nav
          line up with the left edge of the content under them rather than sitting
          in from it. Read from PAGE_WIDTHS so the two cannot drift apart. */}
      <div className={`mx-auto flex min-h-16 ${PAGE_WIDTHS.wide} flex-wrap items-center gap-x-6 gap-y-1 px-8 py-2`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
        <img
          src="/brand/logo-pennie-charcoal.svg"
          alt="Pennie"
          className="h-[22px] w-auto dark:hidden"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- cream variant for the dark theme */}
        <img
          src="/brand/logo-pennie-cream.svg"
          alt="Pennie"
          className="hidden h-[22px] w-auto dark:block"
        />
        <HeaderNav tabs={tabs} />
        <div className="ml-auto flex items-center">
          <AccountMenu
            email={email}
            role={role}
            avatarUrl={avatarUrl}
            themePreference={themePreference}
            calendar={calendar.menu}
          />
        </div>
      </div>
    </header>
    </>
  );
}
