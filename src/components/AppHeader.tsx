import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { agentSchedulingLive } from "@/lib/env";
import { getImpersonation } from "@/lib/auth";
import { stopImpersonation } from "@/app/admin/actions";

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
}: {
  email: string;
  role?: string;
  active: "admin" | "me" | "ooo";
}) {
  // The approval queue is a manager surface; agents manage their own time off
  // from /me, so they don't get the tab.
  const showTimeOff = role === "manager" || role === "admin";
  // OOO-only launch phase: agents see just the time off tool, no scheduling.
  const oooOnly = role === "agent" && !agentSchedulingLive();
  // Persistent banner so an impersonating admin always knows + can get out.
  const impersonation = await getImpersonation();
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
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
          <span className="min-w-0 truncate text-sm text-fg-muted">
            {email}
            {role ? ` · ${role}` : ""}
          </span>
          <ThemeToggle />
          {/* Google reconnect is for availability sync; hidden in the OOO-only
              phase since agents aren't scheduling yet. */}
          {!oooOnly && (
            <a href="/login" className="pn-btn pn-btn--small pn-btn--additional min-h-11">
              Connect / reconnect Google
            </a>
          )}
        </div>
      </div>
    </header>
    </>
  );
}
