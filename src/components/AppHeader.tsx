import Link from "next/link";
import { AccountMenu } from "@/components/AccountMenu";
import { agentSchedulingLive } from "@/lib/env";
import { getImpersonation } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stopImpersonation } from "@/app/admin/actions";
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
  children,
}: {
  href: string;
  current: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`flex min-h-11 min-w-11 items-center ${
        current
          ? "pn-small-bold"
          : "text-sm text-fg-muted transition-colors hover:text-fg"
      }`}
    >
      {children}
    </Link>
  );
}

export async function AppHeader({
  email,
  role,
  active,
  themePreference = "system",
  userId,
  bookable,
  avatarUrl,
}: {
  email: string;
  role?: string;
  active: "admin" | "me" | "ooo";
  themePreference?: ThemePreference;
  userId?: string;
  bookable?: boolean;
  avatarUrl?: string | null;
}) {
  // The approval queue is a manager surface; agents manage their own time off
  // from /me, so they don't get the tab.
  const showTimeOff = role === "manager" || role === "admin";
  // OOO-only launch phase: agents see just the time off tool, no scheduling.
  const oooOnly = role === "agent" && !agentSchedulingLive();
  // Persistent banner so an impersonating admin always knows + can get out.
  const impersonation = await getImpersonation();

  // Google Calendar sync status. DWD reaches calendars by email, so the real
  // per-user "actively syncing" signal is a live push-watch channel. null =
  // not checked (OOO-only agents don't sync). A bookable user with no live
  // watch is the urgent case: their availability can drift and double-book.
  let calendarConnected: boolean | null = null;
  if (userId && !oooOnly) {
    const { data } = await supabaseAdmin()
      .from("agent_calendars")
      .select("watch_expiration")
      .eq("user_id", userId);
    calendarConnected = hasLiveWatch(
      (data ?? []) as { watch_expiration: string | null }[],
    );
  }
  const calendarUrgent = bookable === true && calendarConnected === false;
  return (
    <>
    {impersonation && (
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
    {calendarUrgent && (
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
    <header className="border-b border-border bg-bg">
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
          {oooOnly ? (
            <NavTab href="/me" current={active === "me"}>
              Time off
            </NavTab>
          ) : (
            <>
              <NavTab href="/admin" current={active === "admin"}>
                Admin
              </NavTab>
              <NavTab href="/me" current={active === "me"}>
                My availability
              </NavTab>
              {showTimeOff && (
                <NavTab href="/admin/ooo" current={active === "ooo"}>
                  Time off
                </NavTab>
              )}
            </>
          )}
        </nav>
        <div className="ml-auto flex items-center">
          <AccountMenu
            email={email}
            role={role}
            avatarUrl={avatarUrl}
            themePreference={themePreference}
            calendar={
              oooOnly || calendarConnected === null
                ? "na"
                : calendarConnected
                  ? "connected"
                  : "disconnected"
            }
          />
        </div>
      </div>
    </header>
    </>
  );
}
