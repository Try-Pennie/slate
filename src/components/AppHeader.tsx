import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

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
      className={`flex min-h-11 items-center ${
        current
          ? "pn-small-bold"
          : "text-sm text-fg-muted transition-colors hover:text-fg"
      }`}
    >
      {children}
    </Link>
  );
}

export function AppHeader({
  email,
  role,
  active,
}: {
  email: string;
  role?: string;
  active: "admin" | "me";
}) {
  return (
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
          <NavTab href="/admin" current={active === "admin"}>
            Admin
          </NavTab>
          <NavTab href="/me" current={active === "me"}>
            My availability
          </NavTab>
        </nav>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
          <span className="min-w-0 truncate text-sm text-fg-muted">
            {email}
            {role ? ` · ${role}` : ""}
          </span>
          <ThemeToggle />
          <a href="/login" className="pn-btn pn-btn--small pn-btn--additional min-h-11">
            Connect / reconnect Google
          </a>
        </div>
      </div>
    </header>
  );
}
