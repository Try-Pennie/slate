import { AccountMenu } from "@/components/AccountMenu";
import { SaveForm } from "@/components/ui/SaveForm";
import { ImpersonationFrame } from "@/components/ImpersonationFrame";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { HeaderNav, type HeaderTab } from "@/components/HeaderNav";
import { PAGE_WIDTHS } from "@/components/ui/PageShell";
import { consoleHiddenFor } from "@/lib/env";
import { ME_TABS } from "@/lib/me/nav";
import { consoleHomeFor } from "@/lib/admin/nav";
import {
  atLeast,
  canManageAgents,
  isRole,
  opensStaffConsole,
} from "@/lib/auth/roles";
import { getImpersonationView } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Suspense } from "react";
import { calendarHeaderStatus } from "@/lib/calendar/header-status";
import { PendingApprovalsBadge } from "@/components/header/PendingApprovalsBadge";
import { stopImpersonation } from "@/app/admin/actions";
import { ImpersonationDropNotice } from "@/components/ImpersonationDropNotice";
import { ThemeSync } from "@/components/ThemeSync";
import { ownThemePreference, themeBootScript } from "@/lib/theme/boot";
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
  themePreference,
  userId,
  orgId,
  bookable,
  photoSrc,
  sections = true,
}: {
  email: string;
  role?: string;
  /**
   * The preference of the user this page was rendered FOR. While an admin is
   * viewing as somebody else that is the impersonated person, which is why the
   * header resolves whose theme to paint through `ownThemePreference` rather
   * than using this directly (#2100).
   */
  themePreference: ThemePreference;
  userId?: string;
  orgId?: string;
  bookable?: boolean;
  /** The resolved picture (`staffPhotoSrc`), or null for initials (#3027). */
  photoSrc?: string | null;
  /**
   * False on the coordinator booking page (#4205, D32): its header is the Pennie logo
   * and the account menu, with no section links, for whoever opens it.
   */
  sections?: boolean;
}) {
  // The approval queue is a manager surface; agents manage their own time off
  // from /me/time-off, so they don't get the tab.
  const r = role ?? "";
  const consoleHidden = consoleHiddenFor(role);
  // Approval queue: managers and up. The console: same, behind the launch flag,
  // whose committed production value is on (2026-10-02, #2102).
  const showTimeOff = isRole(r) && atLeast(r, "manager");
  const showAdmin = !consoleHidden && isRole(r) && canManageAgents(r);
  // Persistent banner so an impersonating admin always knows + can get out, plus
  // a one-time notice when a "view as" session was silently dropped (#652).
  const impersonation = await getImpersonationView();
  // Whose theme this session paints: the signed in person's, never the person
  // they are viewing as (#2100). `themePreference` is the page's user, which
  // under "view as" is somebody else entirely.
  const ownTheme = ownThemePreference(impersonation, themePreference);

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
  //
  // Everybody signed in, not only the people who could reach the console. The
  // banner is for a BOOKABLE person whose calendar Slate cannot sync, which is
  // an agent, and until now the launch flag meant an agent was the one person
  // who never saw it. `calendarHeaderStatus` still decides who gets the loud
  // version: `urgent` is gated on `bookable`, so a manager sees nothing.
  const wantsCalendar = Boolean(userId);
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
    // The tab owns the whole console, but where it LANDS depends on who is
    // looking: the Overview is an admin's page, so a manager or team lead goes
    // straight to the roster rather than through the /admin redirect.
    ...(showAdmin && isRole(r)
      ? [{ href: consoleHomeFor(r), section: "/admin", label: "Admin" }]
      : []),
    // Read from the list rather than written out here, so a tab and its page
    // cannot drift apart (L41). `scripts/test-me-nav.ts` resolves every one of
    // them to a real page file.
    // #4205: a role that opens no staff page (a coordinator) has no pages of its own.
    ...(isRole(r) && !opensStaffConsole(r) ? [] : ME_TABS.map((t) => ({ href: t.href, label: t.label }))),
    ...(showTimeOff
      ? [
          {
            href: "/admin/ooo",
            // The twin of "My Time Off" one line up. It was "Team Requests"
            // while the agent's own said "My Requests", and neither said what
            // was being requested (Dan, 2026-09-08). They move together, or the
            // product has two words for one thing (L118).
            label: "Team Time Off",
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
    {/* #2100: the theme is painted HERE, before the first paint, from the
        signed in person's own account row.
        
        It used to be applied by an effect inside the account menu, which
        renders nothing while closed, so opening the menu is what themed the
        page: it painted light, and flipped when somebody clicked their
        initials. This script also mirrors the preference into the cookie, which
        is what the root layout reads on every OTHER surface, so a session that
        never came through the OAuth callback stops being permanently unthemed.
        
        `ownThemePreference` is the rule that the theme belongs to whoever is
        signed in, never to whoever they are viewing as. */}
    <script
      dangerouslySetInnerHTML={{
        __html: themeBootScript({
          kind: "preference",
          preference: ownTheme,
          remember: true,
        }),
      }}
    />
    {/* Keeps a System preference following the device for the whole visit.
        Mounted by the header rather than by the account panel, because a panel
        that renders nothing while closed cannot hold a subscription. */}
    <ThemeSync preference={ownTheme} />
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
        <SaveForm action={stopImpersonation} name="stop-impersonation" unsaved="nothing typed here" onStale="reload">
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
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-[var(--error)] px-4 py-2 text-center text-sm text-[var(--fg-on-error)]">
        <span>
          Your Google Calendar isn&apos;t syncing, so your availability can be
          wrong and you may get double-booked.
        </span>
        <a
          href="/login"
          className="rounded-md bg-[var(--fg-on-error)] px-3 py-1.5 font-semibold text-[var(--error)]"
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
          {/* No nav at all when there is nothing in it, rather than an empty landmark. */}
          {sections && tabs.length > 0 && <HeaderNav tabs={tabs} />}
        </div>
        <div className="ml-auto flex items-center">
          <AccountMenu
            email={email}
            role={role}
            photoSrc={photoSrc}
            themePreference={ownTheme}
            impersonating={impersonation.status === "active"}
            calendar={calendar.menu}
          />
        </div>
      </div>
    </header>
    </>
  );
}
