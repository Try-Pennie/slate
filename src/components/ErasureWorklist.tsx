"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Pill, type PillVariant } from "@/components/ui/Pill";
import { btnCls, btnSecondaryCls, cardCls, proseCls } from "@/components/ui/styles";
import { postJson } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import {
  entryStatus,
  type EntryStatus,
  type ErasureWorklistEntry,
  type ErasureWorklistState,
} from "@/lib/snowflake/erasure-worklist";
import {
  emptyTrailText,
  entryPurgeConfirm,
  entryPurgeLabel,
  entryResidualText,
  entryStatusLabel,
  purgeAllConfirm,
  purgeAllLabel,
  purgeFailedText,
  purgeLeftResidualText,
  purgeStalledText,
  purgeSucceededText,
  purgeTimeoutText,
  purgeWorkingText,
  trailUnreadableText,
  warehouseUnconfiguredText,
  warehouseUnreadableText,
  worklistHeadline,
} from "@/lib/snowflake/erasure-worklist-copy";
import { summarizeWorklist } from "@/lib/snowflake/erasure-worklist";

/**
 * The operator worklist for pending Snowflake erasure purges (#1124).
 *
 * Presentation over two things that already exist: the residual the 6-hourly
 * erasure audit measures, and `POST /api/admin/erasure-purge`, which is the same
 * request the runbook's step 3 tells an operator to make. No erasure logic lives
 * here.
 *
 * Two decisions worth reading before editing.
 *
 * SCOPE PER CONTROL. The route purges EVERY booking in the trail when it is
 * called with no ids, which is what makes a missed purge fix itself, and a subset
 * when it is given ids. Both are offered, and each control names which one it is
 * in its label AND in the sentence it shows before it runs. That was the one
 * design question the issue left open, and leaving it to fall out of the request
 * body would mean the screen could not say what the button does.
 *
 * THREE PROGRESS STATES. The purge is a several second warehouse round trip, so
 * a bare spinner is not enough: the working state carries an elapsed second count
 * (a run that is alive looks different from one that is dead), it changes wording
 * once it runs long, and `postJson`'s abort turns a wedged request into a stated
 * timeout with a retry rather than an indefinite wait. The timeout deliberately
 * does not claim the purge FAILED, because we only know we stopped waiting.
 */

/**
 * How long to wait for the round trip. Longer than the booking flow's 20s, since
 * this runs five warehouse statements against Snowflake, and shorter than the
 * route's own 120s lock so a timed out attempt is not still holding it when the
 * operator retries.
 */
export const PURGE_TIMEOUT_MS = 90_000;

/** Say "still going" once a run passes this, well before the deadline above. */
const STILL_GOING_AFTER_MS = 10_000;

interface PurgeResponse {
  ok?: boolean;
  error?: string;
  bookingIds?: string[];
  rowsByTable?: Record<string, number>;
  reasons?: string[];
}

type Target = { kind: "all" } | { kind: "entry"; entry: ErasureWorklistEntry };

type Outcome =
  | { kind: "ok"; bookingIds: string[]; rowsByTable: Record<string, number> }
  | { kind: "residual"; reasons: string[] }
  | { kind: "failed"; reason: string | null }
  | { kind: "timeout" };

const STATUS_PILL: Record<EntryStatus, PillVariant> = {
  clean: "status-ok",
  outstanding: "status-error",
  unknown: "status-pending",
};

/** Absolute local time: an erasure is a compliance record read weeks later. */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function ErasureWorklist({ state }: { state: ErasureWorklistState }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [busy, setBusy] = useState<Target | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const stillGoing = useStalledAfter(busy !== null, STILL_GOING_AFTER_MS);

  // The heartbeat. Without it a live run and a dead one are the same picture.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  if (state.kind === "trail-unreadable") {
    return (
      <div role="alert" className="rounded-xl border border-[var(--error)] px-5 py-4 text-sm text-error">
        {trailUnreadableText(state.reason)}
      </div>
    );
  }

  const { entries, trail, warehouse } = state;
  const summary = summarizeWorklist(entries);
  const purgeable = warehouse.kind !== "unconfigured";

  async function run(target: Target) {
    setConfirming(null);
    setOutcome(null);
    setElapsed(0);
    setBusy(target);
    const body = target.kind === "all" ? {} : { bookingIds: target.entry.bookingIds };
    try {
      const { ok, status, data } = await postJson<PurgeResponse>(
        "/api/admin/erasure-purge",
        body,
        { timeoutMs: PURGE_TIMEOUT_MS },
      );
      if (ok) {
        setOutcome({ kind: "ok", bookingIds: data.bookingIds ?? [], rowsByTable: data.rowsByTable ?? {} });
        router.refresh();
      } else if (status === 0) {
        // The abort fired, or the network never answered. We know we stopped
        // waiting; we do NOT know the warehouse did nothing.
        setOutcome({ kind: "timeout" });
      } else if (data.reasons && data.reasons.length > 0) {
        setOutcome({ kind: "residual", reasons: data.reasons });
      } else {
        setOutcome({ kind: "failed", reason: data.error ?? null });
      }
    } finally {
      setBusy(null);
    }
  }

  function confirmPanel(target: Target) {
    const text = target.kind === "all" ? purgeAllConfirm(trail) : entryPurgeConfirm(target.entry);
    const id = target.kind === "all" ? "purge-confirm-all" : `purge-confirm-${target.entry.auditId}`;
    return (
      <div
        role="alertdialog"
        aria-labelledby={id}
        className="pn-confirm-enter mt-2 rounded-lg bg-error/5 p-3"
      >
        <p id={id} className="text-sm text-fg">
          {text}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {/* Focus lands on the SAFE option: this panel announces itself as an
              alertdialog, so a keyboard or screen reader user has to arrive
              somewhere, and arriving on the destructive button is the wrong
              somewhere. */}
          <button
            type="button"
            autoFocus
            className={btnSecondaryCls}
            onClick={() => setConfirming(null)}
          >
            Leave it
          </button>
          <button type="button" className={btnCls} onClick={() => void run(target)}>
            Yes, purge
          </button>
        </div>
      </div>
    );
  }

  const progress = busy ? (
    <p role="status" className="mt-2 text-sm text-fg-muted tabular-nums">
      {stillGoing ? purgeStalledText(elapsed) : purgeWorkingText(elapsed)}
    </p>
  ) : null;

  const outcomePanel = outcome ? (
    <div
      role="alert"
      className={`mt-3 rounded-lg px-4 py-3 text-sm ${
        outcome.kind === "ok"
          ? "bg-pennie-sky-soft text-pennie-graphite"
          : "border border-[var(--error)] text-error"
      }`}
    >
      {outcome.kind === "ok"
        ? purgeSucceededText({ bookingIds: outcome.bookingIds, rowsByTable: outcome.rowsByTable })
        : outcome.kind === "residual"
          ? purgeLeftResidualText(outcome.reasons)
          : outcome.kind === "timeout"
            ? purgeTimeoutText(Math.round(PURGE_TIMEOUT_MS / 1000))
            : purgeFailedText(outcome.reason)}
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
        <p className="pn-eyebrow text-pennie-sky">Data subject erasures</p>
        <h1 className="pn-h2 mt-2 text-pennie-beige">{worklistHeadline(summary)}</h1>
        <p className="mt-2 text-pennie-beige/75">
          The Supabase half of every erasure is already done. This is the warehouse
          half: what Snowflake still holds for the people whose data Slate has
          erased, and the control that clears it.
        </p>
      </section>

      {warehouse.kind === "unreadable" && (
        <div role="alert" className="rounded-xl border border-[var(--error)] px-5 py-4 text-sm text-error">
          {warehouseUnreadableText(warehouse.reason)}
        </div>
      )}
      {warehouse.kind === "unconfigured" && (
        <div role="alert" className="rounded-xl border border-border bg-bg-alt px-5 py-4 text-sm text-fg-muted">
          {warehouseUnconfiguredText()}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-fg-muted">
          {emptyTrailText()}
        </p>
      ) : (
        <ul className="space-y-4">
          {entries.map((e) => {
            const status = entryStatus(e);
            const isBusy = busy?.kind === "entry" && busy.entry.auditId === e.auditId;
            const isConfirming = confirming?.kind === "entry" && confirming.entry.auditId === e.auditId;
            return (
              <li key={e.auditId} className={cardCls}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                      <Pill variant={STATUS_PILL[status]}>{entryStatusLabel(status)}</Pill>
                      <span className="tabular-nums text-fg-muted">{stamp(e.createdAt)}</span>
                    </p>
                    <p className="mt-2 font-mono text-xs break-all text-fg-muted">
                      {e.emailSha256
                        ? `email hash ${e.emailSha256.slice(0, 12)}`
                        : "no email hash recorded"}
                      {`, ${e.bookingIds.length} booking${e.bookingIds.length === 1 ? "" : "s"}`}
                    </p>
                    <p className="mt-2 text-sm text-fg-muted">{entryResidualText(e)}</p>
                  </div>
                  {purgeable && (
                    <button
                      type="button"
                      className={btnSecondaryCls}
                      disabled={busy !== null}
                      onClick={() => setConfirming({ kind: "entry", entry: e })}
                    >
                      {entryPurgeLabel()}
                    </button>
                  )}
                </div>
                {isConfirming && confirmPanel({ kind: "entry", entry: e })}
                {isBusy && progress}
              </li>
            );
          })}
        </ul>
      )}

      {purgeable && trail.bookingCount > 0 && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">The wider control</h2>
          {confirming?.kind === "all" ? (
            confirmPanel({ kind: "all" })
          ) : (
            <>
              <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>{purgeAllConfirm(trail)}</p>
              <button
                type="button"
                className={btnCls}
                disabled={busy !== null}
                onClick={() => setConfirming({ kind: "all" })}
              >
                {purgeAllLabel()}
              </button>
            </>
          )}
          {busy?.kind === "all" && progress}
        </section>
      )}

      {/* One outcome panel, at the end. The row (or the section) that started the
          run may not be the right place for it: a successful purge refreshes the
          list underneath, so the result has to outlive its own control. */}
      {outcomePanel}
    </div>
  );
}
