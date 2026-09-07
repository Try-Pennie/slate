import { AccountMenu } from "@/components/AccountMenu";
import { SaveForm } from "@/components/ui/SaveForm";
import { ImpersonationFrame } from "@/components/ImpersonationFrame";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { HeaderNav, type HeaderTab } from "@/components/HeaderNav";
import { PAGE_WIDTHS } from "@/components/ui/PageShell";
import { oooOnlyFor } from "@/lib/env";
import {
  atLeast,
  canManageAgents,
  isRole,
} from "@/lib/auth/roles";
import { getImpersonationView } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Suspense } from "react";
import { calendarHeaderStatus } from "@/lib/calendar/header-status";
import { PendingApprovalsBadge } from "@/components/header/PendingApprovalsBadge";
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
  // #1847: ONLY the calendar read is awaited here now.
  //
  // The staff id read and the pending count moved into
  // `PendingApprovalsBadge`, behind a Suspense boundary below, because they were
  // the last two hops of a chain in front of every internal page and nothing on
  // the page needs them. Measured in production on 2026-09-03: an admin page
  // came back in 100 to 563ms of wall time on 8 to 37ms of Worker CPU, and on
  // `/admin/agents` the roster read finished at +391ms while the count had not
  // started until +390ms.
  //
  // THE CALENDAR READ STAYS AWAITED, deliberately. Its urgent banner is drawn
  // ABOVE the header, so a late arrival would push the whole page down under
  // somebody already reading it, and it is a real warning rather than a nudge:
  // #1847 says it must not shift the layout and must not be possible to miss.
  // Deferring it would also save nothing, since it ran alongside the staff read
  // rather than after it.
  const calendarRows = wantsCalendar
    ? // error-ok: a failed read leaves `checked: false`, which is the "we did
      // not look" state calendarHeaderStatus already models, and the banner
      // stays silent rather than claiming a calendar is broken. The every
      // minute sync lane is what actually reports a broken calendar.
      ((
        await supabaseAdmin()
          .from("agent_calendars")
          .select("watch_expiration")
          .eq("user_id", userId!)
      ).data as { watch_expiration: string | null }[] | null)
    : null;

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

  // Which tab is CURRENT is decided by HeaderNav from the path, not here: since
  // #1748 the admin console renders this header once from its layout, which wraps
  // /admin and /admin/ooo alike, so there is no page left in a position to say.
  const tabs: HeaderTab[] = [
    ...(showAdmin ? [{ href: "/admin", label: "Admin" }] : []),
    { href: "/me", label: meLabel },
    ...(showTimeOff
      ? [
          {
            href: "/admin/ooo",
            label: "Team Requests",
            // #1847: the count arrives under its own boundary, so the tab
            // renders now and the badge a moment later. `null` while it loads,
            // not a placeholder pill: a badge is absent far more often than it
            // is present, and a shape that resolves to nothing would flicker on
            // every page load for most people.
            badge: (
              <Suspense fallback={null}>
                <PendingApprovalsBadge role={r} userId={userId} orgId={orgId} />
              </Suspense>
            ),
          },
        ]
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
    {/* #2037: a hazard striped frame around the viewport, not a bar in the flow.
        The treatment is settled and recorded (DESIGN.md's Hazard Rule, and
        docs/design/impersonation-marker.html); the component carries the reasons.
        The way out is passed IN because it is a server action's form, and it is
        an outlined graphite button rather than a primary one, so sky stays the
        only colour in the product that means "do this" (IM7). */}
    {impersonation.status === "active" && (
      <ImpersonationFrame
        name={impersonation.target.name}
        email={impersonation.target.email}
        role={impersonation.target.role}
      >
        <SaveForm action={stopImpersonation} name="stop-impersonation" onStale="reload">
          <SubmitButton
            className="pn-impersonation-exit"
            pendingLabel="Returning to your own view"
          >
            Stop viewing as them
          </SubmitButton>
        </SaveForm>
      </ImpersonationFrame>
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
    <header data-app-header="" className="sticky top-0 z-30 border-b border-border bg-bg">
      {/* #1745: the same cap the page content uses, so the wordmark and the nav
          line up with the left edge of the content under them rather than sitting
          in from it. Read from PAGE_WIDTHS so the two cannot drift apart. */}
      <div className={`mx-auto flex min-h-16 ${PAGE_WIDTHS.wide} flex-wrap items-center gap-x-6 gap-y-1 px-8 py-2`}>
        {/* #2038: the wordmark and the nav labels sit on ONE baseline.
            
            They were each centred independently, the wordmark in the bar and each
            label inside its own 44px touch target, which put the labels against
            the MIDDLE of the wordmark rather than its feet.
            
            This is an inner row, not `items-baseline` on the bar itself, for two
            reasons. Baseline alignment packs its line to the START of the cross
            axis, so putting it on the bar would drop the whole group to the top
            of the 64px row; the group is baseline aligned WITHIN itself and then
            centred as one thing. And the account menu on the right has no
            business sharing a baseline with a wordmark.
            
            The 44px targets are untouched: baseline alignment moves the boxes to
            line their text up, it does not resize them. */}
        <div className="flex items-baseline gap-x-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
          <img
            src="/brand/logo-pennie-charcoal.svg"
            alt="Pennie"
            className="pn-wordmark h-[22px] w-auto dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- cream variant for the dark theme */}
          <img
            src="/brand/logo-pennie-cream.svg"
            alt="Pennie"
            className="pn-wordmark hidden h-[22px] w-auto dark:block"
          />
          <HeaderNav tabs={tabs} />
        </div>
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
