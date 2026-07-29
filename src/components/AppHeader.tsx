import Link from "next/link";
import { AccountMenu } from "@/components/AccountMenu";
import { LinkPending } from "@/components/ui/LinkPending";
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

function NavTab({
  href,
  current,
  badge,
  children,
}: {
  href: string;
  current: boolean;
  /** Optional count shown as a sky-soft badge (e.g. pending approvals). */
  badge?: number;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`flex min-h-11 min-w-11 items-center gap-1.5 ${
        current
          ? "pn-small-bold"
          : "text-sm text-fg-muted transition-colors hover:text-fg"
      }`}
    >
      {children}
      {!!badge && badge > 0 && (
        <>
          <span
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-pennie-sky-soft px-1.5 text-xs font-semibold tabular-nums text-pennie-blue dark:bg-accent/15 dark:text-pennie-sky"
          >
            {badge > 99 ? "99+" : badge}
          </span>
          <span className="sr-only">
            ({badge} {badge === 1 ? "request" : "requests"} pending)
          </span>
        </>
      )}
      <LinkPending />
    </Link>
  );
}

export async function AppHeader({
  email,
  role,
  active,
  themePreference = "system",
  userId,
  orgId,
  bookable,
  avatarUrl,
}: {
  email: string;
  role?: string;
  active: "admin" | "me" | "ooo";
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
  let calendar = calendarHeaderStatus({
    checked: false,
    bookable: bookable === true,
    hasCalendars: false,
    hasLiveWatch: false,
  });
  if (userId && !oooOnly) {
    const { data } = await supabaseAdmin()
      .from("agent_calendars")
      .select("watch_expiration")
      .eq("user_id", userId);
    const rows = (data ?? []) as { watch_expiration: string | null }[];
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
  if (showTimeOff && userId && orgId) {
    // Exclude requests authored by admins/super admins, mirroring the Team
    // Requests page, so test/operator requests can't inflate the badge.
    const { data: staff } = await supabaseAdmin()
      .from("users")
      .select("id")
      .eq("org_id", orgId)
      .in("role", ["admin", "super_admin"]);
    const staffIds = ((staff ?? []) as { id: string }[]).map((u) => u.id);

    let q = supabaseAdmin()
      .from("ooo_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending");
    if (staffIds.length > 0) {
      q = q.not("user_id", "in", `(${staffIds.join(",")})`);
    }
    // showTimeOff already implies isRole(r); the guard just narrows the type.
    if (isRole(r) && !canModerateAllOoo(r)) q = q.eq("manager_id", userId);
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
  return (
    <>
    {impersonation.status === "active" && (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-pennie-navy px-4 py-2 text-center text-sm text-pennie-beige">
        <span>
          Viewing as{" "}
          <strong>{impersonation.target.name ?? impersonation.target.email}</strong>{" "}
          ({impersonation.target.role}). Actions you take happen as them.
        </span>
        <form action={stopImpersonation}>
          <button className="pn-btn pn-btn--small pn-btn--primary">
            Stop viewing as them
          </button>
        </form>
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
      <div className="mx-auto flex min-h-16 max-w-4xl flex-wrap items-center gap-x-6 gap-y-1 px-8 py-2">
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
        <nav aria-label="Slate sections" className="flex items-center gap-5">
          {showAdmin && (
            <NavTab href="/admin" current={active === "admin"}>
              Admin
            </NavTab>
          )}
          <NavTab href="/me" current={active === "me"}>
            {meLabel}
          </NavTab>
          {showTimeOff && (
            <NavTab href="/admin/ooo" current={active === "ooo"} badge={pendingOoo}>
              Team Requests
            </NavTab>
          )}
        </nav>
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
