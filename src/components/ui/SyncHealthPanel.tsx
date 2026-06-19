import type { ReactElement } from "react";

/** One persistently-failing agent calendar, shaped for admin display (#273). */
export interface SyncHealthRow {
  email: string;
  name: string | null;
  consecutiveFailures: number;
  /** ISO timestamp of the last clean sync/renew, or null if never. */
  lastSuccessAt: string | null;
  error: string | null;
}

/**
 * Per-agent calendar sync health for the admin page (#273 Phase 1.3). Shows the
 * operator exactly WHO is failing, how long, and what to do — replacing the
 * hand DB query the old anonymous alert forced. Color is paired with text (not
 * the sole signal) for accessibility; tokens only, no raw hex.
 */
export function SyncHealthPanel({ agents }: { agents: SyncHealthRow[] }): ReactElement {
  if (agents.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted tabular-nums">
        <span className="inline-block h-2 w-2 rounded-full bg-pennie-green" />
        all calendars syncing
      </span>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-alt)] px-5 py-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="inline-block h-2 w-2 rounded-full bg-pennie-yellow" />
        {agents.length} agent{agents.length === 1 ? "" : "s"} with a calendar failing to sync
      </p>
      <ul className="mt-3 space-y-2">
        {agents.map((a) => {
          const lastOk = a.lastSuccessAt ? a.lastSuccessAt.slice(0, 10) : "never";
          return (
            <li key={a.email} className="text-sm">
              <span className="font-semibold text-fg">{a.name ?? a.email}</span>
              {a.name ? <span className="text-fg-muted"> ({a.email})</span> : null}
              <span className="text-fg-muted tabular-nums">
                {` ${a.consecutiveFailures} consecutive failure${a.consecutiveFailures === 1 ? "" : "s"}, last ok ${lastOk}${a.error ? `: ${a.error}` : ""}`}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-fg-muted">
        Re-auth or deactivate the affected agent(s) to clear this.
      </p>
    </div>
  );
}
