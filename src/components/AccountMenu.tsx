"use client";

import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { ThemePreference } from "@/lib/db/types";
import type { CalendarMenuStatus } from "@/lib/calendar/header-status";

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
  avatarUrl,
}: {
  email: string;
  role?: string;
  themePreference: ThemePreference;
  calendar: CalendarMenuStatus;
  avatarUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account and settings"
        className="flex min-h-11 items-center gap-1.5 rounded-md px-1.5 text-fg-muted transition-colors hover:bg-[var(--bg-alt)] hover:text-fg"
      >
        <span className="relative">
          {avatarUrl && imgOk ? (
            // eslint-disable-next-line @next/next/no-img-element -- external Google avatar; OpenNext/CF has no image loader
            <img
              src={avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setImgOk(false)}
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-pennie-navy text-xs font-semibold text-pennie-beige">
              {initials}
            </span>
          )}
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

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-border bg-surface p-4 shadow-pop"
        >
          <p className="truncate text-sm font-semibold text-fg">{email}</p>
          {role && (
            <p className="text-xs capitalize text-fg-muted">
              {role.replace("_", " ")}
            </p>
          )}

          {calendar !== "na" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
              {calendar === "connected" && (
                <span className="inline-flex items-center gap-2 text-fg-muted">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full bg-[var(--pennie-green-deep)]"
                  />
                  Calendar connected
                </span>
              )}
              {calendar === "degraded" && (
                // Real-time push is delayed but the every-minute backstop still
                // syncs this agent, so this is informational, not the loud case.
                <span className="inline-flex items-center gap-2 text-fg-muted">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full bg-[var(--pennie-yellow)]"
                  />
                  Calendar syncing (live updates delayed)
                </span>
              )}
              {calendar === "disconnected" && (
                <>
                  <span className="inline-flex items-center gap-2 font-semibold text-error">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full bg-[var(--error)]"
                    />
                    Calendar not connected
                  </span>
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

          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 text-xs font-semibold text-fg-muted">Theme</p>
            <ThemeToggle preference={themePreference} />
          </div>
        </div>
      )}
    </div>
  );
}
