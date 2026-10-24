"use client";

import { AdvisorAvatar } from "@/components/ui/AdvisorAvatar";
import { useEffect, useRef, useState } from "react";
import { SaveForm } from "@/components/ui/SaveForm";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { signOut } from "@/app/auth-actions";
import type { ThemePreference } from "@/lib/db/types";
import type { CalendarMenuStatus } from "@/lib/calendar/header-status";
import { MarkedLabel } from "@/components/ui/MarkedLabel";

/**
 * Collapses the header's secondary chrome — identity, theme, calendar status —
 * into one avatar button that opens a small panel, so the header stays
 * uncluttered (wordmark + nav + this). The loud "disconnected" banner lives
 * separately at the top of the header for the urgent case.
 */
export function AccountMenu({
  email,
  role,
  themePreference,
  calendar,
  photoSrc,
  impersonating = false,
}: {
  email: string;
  role?: string;
  /** The SIGNED IN person's own preference, never the one being viewed as. */
  themePreference: ThemePreference;
  calendar: CalendarMenuStatus;
  /** The resolved picture, or null for initials (#3027). */
  photoSrc?: string | null;
  /** True while this session is viewing as somebody else (#2100). */
  impersonating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // #1843: the panel is portalled now, so it is no longer a descendant of `ref`,
  // and an outside-click test written against `ref` alone would close the menu
  // the moment somebody clicked inside it. AnchoredPanel owns that test, since it
  // is the only thing that can see both the trigger and the portalled panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        // #3917 (L786): with no photo the button DRAWS the initials, and somebody
        // driving by voice says what they see, so the name starts with them. Kept
        // over a photo too, since only AdvisorAvatar knows whether the picture loaded.
        aria-label={`${initials}, account and settings`}
        className="flex min-h-11 items-center gap-1.5 rounded-md px-1.5 text-fg-muted transition-colors hover:bg-[var(--bg-alt)] hover:text-fg"
      >
        <span className="relative">
          {/* The one avatar component (#3027, #2612). */}
          <AdvisorAvatar
            src={photoSrc ?? null}
            initials={initials}
            imgClassName="h-7 w-7 rounded-full object-cover"
            fallbackClassName="flex h-7 w-7 items-center justify-center rounded-full bg-pennie-navy text-xs font-semibold text-pennie-beige"
          />
          {/* Alert badge so a calendar disconnect is visible without opening. */}
          {calendar === "disconnected" && (
            <span
              aria-hidden
              title="Calendar not connected"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg bg-[var(--error)]"
            />
          )}
        </span>
        <svg
          aria-hidden
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <AnchoredPanel
        open={open}
        onDismiss={() => setOpen(false)}
        triggerRef={triggerRef}
        align="end"
        gap={8}
        role="menu"
        className="w-64 rounded-md border border-border bg-surface p-4 shadow-pop"
      >
        <>
          <p className="truncate text-sm font-semibold text-fg">{email}</p>
          {role && (
            <p className="text-xs capitalize text-fg-muted">
              {role.replace("_", " ")}
            </p>
          )}

          {calendar !== "na" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
              {calendar === "connected" && (
                <MarkedLabel
                  className="gap-2 text-fg-muted"
                  mark={<span className="h-2 w-2 rounded-full bg-[var(--pennie-green-deep)]" />}
                >
                  Calendar connected
                </MarkedLabel>
              )}
              {calendar === "degraded" && (
                // Real-time push is delayed but the every-minute backstop still
                // syncs this agent, so this is informational, not the loud case.
                <MarkedLabel
                  className="gap-2 text-fg-muted"
                  mark={<span className="h-2 w-2 rounded-full bg-[var(--pennie-yellow)]" />}
                >
                  Calendar syncing (live updates delayed)
                </MarkedLabel>
              )}
              {calendar === "disconnected" && (
                <>
                  <MarkedLabel
                    className="gap-2 font-semibold text-error"
                    mark={<span className="h-2 w-2 rounded-full bg-[var(--error)]" />}
                  >
                    Calendar not connected
                  </MarkedLabel>
                  <a
                    href="/login"
                    className="text-pennie-blue underline dark:text-pennie-sky"
                  >
                    Reconnect
                  </a>
                </>
              )}
            </div>
          )}

          {/* #1746: the control carries its own <legend>Theme</legend>, so the
              heading that used to sit here would be a second, unlinked copy of
              the same word.

              #2100: absent while viewing as somebody else, rather than shown and
              refusing. The page belongs to the person being impersonated and the
              write belongs to the admin, so a control here could only ever
              display one and change the other. It is removed rather than
              disabled because a disabled control still invites the press and
              still has to explain itself. The theme keeps being APPLIED
              throughout, from the admin's own preference: that half lives in the
              header, which is where it has to be anyway, since this panel
              renders nothing while it is closed. */}
          {!impersonating && (
            <div className="mt-3 border-t border-border pt-3">
              <ThemeToggle preference={themePreference} />
            </div>
          )}

          <SaveForm
            action={signOut}
            name="sign-out"
            unsaved="nothing typed here"
            onStale="reload"
            className="mt-3 border-t border-border pt-3"
          >
            <SubmitButton
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-1.5 text-sm text-fg-muted transition-colors hover:bg-[var(--bg-alt)] hover:text-fg"
              pendingLabel="Signing out"
            >
              <svg
                aria-hidden
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6" />
                <path d="M10.5 11 13.5 8l-3-3" />
                <path d="M13.5 8H6" />
              </svg>
              Sign out
            </SubmitButton>
          </SaveForm>
        </>
      </AnchoredPanel>
    </div>
  );
}
