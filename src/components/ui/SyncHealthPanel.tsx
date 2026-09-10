import type { ReactElement } from "react";
import { shortFailureReason } from "@/lib/notify/error-text";
import { MarkedLabel } from "@/components/ui/MarkedLabel";

/** One persistently-failing agent calendar, shaped for admin display (#273). */
export interface SyncHealthRow {
  email: string;
  name: string | null;
  consecutiveFailures: number;
  /** ISO timestamp of the last clean pass on this row's lane, or null if never. */
  lastSuccessAt: string | null;
  error: string | null;
  /**
   * Which lane is failing (#1150). The two are separate conditions with separate
   * counters: "events are not reaching the availability cache" (sync) and "the
   * Google push channel is not being renewed" (watch). They read very
   * differently to an operator, and a days-old timestamp is alarming on one and
   * entirely normal on the other. Defaults to sync for callers predating #1150.
   */
  lane?: "sync" | "watch";
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
      <MarkedLabel
        className="gap-1.5 text-xs text-fg-muted tabular-nums"
        mark={<span className="h-2 w-2 rounded-full bg-pennie-green" />}
      >
        all calendars syncing
      </MarkedLabel>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-alt)] px-5 py-4"
    >
      <p className="text-sm font-semibold text-fg">
        <MarkedLabel
          className="gap-2"
          mark={<span className="h-2 w-2 rounded-full bg-pennie-yellow" />}
        >
          {agents.length} agent{agents.length === 1 ? "" : "s"} with a calendar problem
        </MarkedLabel>
      </p>
      <ul className="mt-3 space-y-2">
        {agents.map((a) => {
          const watch = a.lane === "watch";
          // #1150: the label has to match the lane. "last ok 4 days ago" reads as
          // a four-day outage, but a renewal four days old is exactly healthy.
          const stamp = a.lastSuccessAt ? a.lastSuccessAt.slice(0, 10) : "never";
          const what = watch ? "failing to renew its push channel" : "failing to sync";
          const stampLabel = watch ? "last renewed" : "last ok";
          // #1789: `error` holds whatever the calendar read threw, which for an
          // OAuth refusal is a whole JSON body. Interpolated raw it pushed the
          // health summary off the line. `shortFailureReason` is the one place
          // that decision lives (#1135), so this surface asks it rather than
          // re-deciding. It returns null only for an absent error, so the
          // clause is omitted in exactly the cases it was before.
          const reason = shortFailureReason(a.error);
          return (
            <li key={`${a.lane ?? "sync"}:${a.email}`} className="text-sm">
              <span className="font-semibold text-fg">{a.name ?? a.email}</span>
              {a.name ? <span className="text-fg-muted"> ({a.email})</span> : null}
              <span className="text-fg-muted tabular-nums">
                {` ${what}, ${a.consecutiveFailures} consecutive failure${a.consecutiveFailures === 1 ? "" : "s"}, ${stampLabel} ${stamp}${reason ? `: ${reason}` : ""}`}
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
