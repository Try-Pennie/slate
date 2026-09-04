"use client";

import { useEffect, useState } from "react";

import type { ReasonOption } from "@/lib/booking/core";
import type { BulkReassignActionableItem, BulkReassignProgress } from "@/lib/booking/bulk-reassign";
import { formatSlotTime } from "@/lib/booking/slot-label";
import {
  COVERAGE_PANEL_NAME,
  coveragePanelDescription,
  coveragePanelTimeOffNote,
} from "@/lib/booking/coverage-panel-copy";
import { getJson, postJson } from "@/lib/http";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import { SelectField } from "@/components/ui/SelectField";

const POLL_MS = 3000;
/** After this many consecutive poll failures, show a distinct "lost contact"
 *  state instead of a spinner that looks identical to healthy progress. */
const MAX_POLL_FAILURES = 3;

/** Build the ISO range from the two date inputs: an empty start means now
 *  onward; an end date is made inclusive of that whole local day. */
function toRange(from: string, to: string): { from?: string; to: string | null } {
  return {
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : null,
  };
}

const STATUS_LABEL: Record<string, string> = {
  moved: "Moved",
  unplaceable: "Couldn't place",
  skipped: "Skipped",
  failed: "Failed",
  pending: "In progress",
};

/**
 * Admin panel to reassign an out agent's upcoming bookings onto covering agents
 * for coverage (#974, #562). Pick a range (default now onward) and a reason, see
 * a live preview count, start the sweep, then watch progress. Each booking that
 * couldn't be placed links to the single-reassign force-override on its booking
 * page. The move sends the customer one explained invite; the time never changes.
 */
export default function BulkReassignCoverage({
  agentId,
  agentName,
  reassignReasons,
  initialJobId,
}: {
  agentId: string;
  agentName: string;
  /** Active reassign reason options, resolved from the store server-side (#346). */
  reassignReasons: ReasonOption[];
  /**
   * A sweep to open ON, rather than the start form (#1239). The time off queue links
   * here with the job an approval enqueued, so whoever was told in Slack that a dozen
   * appointments are moving can watch them land. The progress read is scoped to this
   * agent server-side, so a job belonging to somebody else 404s rather than showing.
   */
  initialJobId?: string;
}) {
  const base = `/api/admin/agents/${agentId}/bulk-reassign`;
  const today = new Date().toISOString().slice(0, 10);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  // Default to the first available reason, never a hardcoded code that an admin
  // may have retired (#346/#987). A stale value would leave the select opened
  // on an option that is not in the list.
  const [reasonCode, setReasonCode] = useState(() => reassignReasons[0]?.code ?? "");
  const [reasonDetail, setReasonDetail] = useState("");

  const [preview, setPreview] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [progress, setProgress] = useState<BulkReassignProgress | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // Live preview count, debounced on the range. Skipped once a job is running.
  // setState only inside the (async) timer callback, never synchronously in the
  // effect body, mirroring useFetchList.
  useEffect(() => {
    if (jobId) return;
    let cancelled = false;
    const params = new URLSearchParams();
    const r = toRange(from, to);
    if (r.from) params.set("from", r.from);
    if (r.to) params.set("to", r.to);
    const t = setTimeout(async () => {
      if (cancelled) return;
      setPreviewLoading(true);
      const res = await getJson<{ count?: number }>(`${base}?${params.toString()}`).catch(() => null);
      if (cancelled) return;
      setPreviewLoading(false);
      setPreview(res && res.ok ? (res.data?.count ?? null) : null);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [base, from, to, jobId]);

  // Poll while a job is running and not yet done. The fetch lives in the effect
  // (like useFetchList) so setState only happens after an await, never
  // synchronously in the effect body.
  const done = progress?.summary.done ?? false;
  useEffect(() => {
    if (!jobId || done) return;
    let cancelled = false;
    const tick = async () => {
      const res = await getJson<BulkReassignProgress>(`${base}?jobId=${encodeURIComponent(jobId)}`).catch(
        () => null,
      );
      if (cancelled) return;
      if (res && res.ok && res.data) {
        setProgress(res.data);
        setLastUpdated(Date.now());
        setPollFailures(0);
      } else {
        setPollFailures((n) => n + 1);
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [base, jobId, done]);

  async function start() {
    setStarting(true);
    setError(null);
    const r = toRange(from, to);
    const res = await postJson<{ jobId?: string; error?: string }>(base, {
      from: r.from,
      to: r.to,
      reason: reasonCode,
      reasonDetail: reasonCode === "other" ? reasonDetail : undefined,
    }).catch(() => null);
    setStarting(false);
    if (!res || !res.ok || !res.data?.jobId) {
      setError(res?.data?.error ?? "Couldn't start the reassign. Please try again.");
      return;
    }
    setProgress(null);
    setPollFailures(0);
    setJobId(res.data.jobId);
  }

  function reset() {
    setJobId(null);
    setProgress(null);
    setError(null);
    setPollFailures(0);
    setLastUpdated(null);
  }

  const lostContact = pollFailures >= MAX_POLL_FAILURES;

  return (
    <section className={cardCls}>
      {/* #1876: the wording lives in a pure builder, like the time off notices,
          because copy that can only be read by rendering the page is copy nobody
          reviews. The name is a constant every message pointing here derives
          from, so a rename cannot leave a Slack sentence naming a section that
          does not exist. */}
      <p className="pn-eyebrow text-fg-muted">{COVERAGE_PANEL_NAME}</p>
      <p className={`mt-2 text-sm text-fg-muted ${proseCls}`}>
        {coveragePanelDescription(agentName)}
      </p>
      <p className={`mt-2 text-sm text-fg-muted ${proseCls}`}>{coveragePanelTimeOffNote()}</p>

      {!jobId ? (
        <>
          {/* #1876: the reason LEADS. It is the situation the reader arrived
              with ("why am I moving these"), so asking it first answers the
              question the old copy left them forming. The range follows, since
              it is a detail of the situation rather than the situation. */}
          <div className="mt-4">
            <label className={labelCls} htmlFor="bulk-reason">
              Reason
            </label>
            <SelectField
              id="bulk-reason"
              className="w-full"
              value={reasonCode}
              onChange={setReasonCode}
              options={reassignReasons.map((r) => ({ value: r.code, label: r.label }))}
            />
            {reasonCode === "other" && (
              <input
                type="text"
                className={`${inputCls} mt-2`}
                placeholder="Tell us a bit more"
                value={reasonDetail}
                maxLength={500}
                onChange={(e) => setReasonDetail(e.target.value)}
              />
            )}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="bulk-from">
                From
              </label>
              <input
                id="bulk-from"
                type="date"
                className={inputCls}
                value={from}
                min={today}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="bulk-to">
                Until (optional)
              </label>
              <input
                id="bulk-to"
                type="date"
                className={inputCls}
                value={to}
                min={from || today}
                onChange={(e) => setTo(e.target.value)}
              />
              <p className="mt-1 text-xs text-fg-muted">Leave blank to cover everything from the start date onward.</p>
            </div>
          </div>

          <p className="mt-4 text-sm text-fg" aria-live="polite">
            {previewLoading
              ? "Counting bookings in range…"
              : preview === null
                ? "Enter a range to see how many bookings would move."
                : preview === 0
                  ? "No upcoming bookings in this range."
                  : `${preview} booking${preview === 1 ? "" : "s"} would be reassigned.`}
          </p>

          {error && <p className="mt-3 text-sm text-[var(--error)]">{error}</p>}

          <button
            type="button"
            className={`${btnCls} mt-4 disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={starting || previewLoading || preview === 0 || (reasonCode === "other" && !reasonDetail.trim())}
            onClick={start}
          >
            {starting ? "Starting…" : "Move these bookings"}
          </button>
        </>
      ) : (
        <Progress
          progress={progress}
          lostContact={lostContact}
          lastUpdated={lastUpdated}
          onReset={reset}
        />
      )}
    </section>
  );
}

function Progress({
  progress,
  lostContact,
  lastUpdated,
  onReset,
}: {
  progress: BulkReassignProgress | null;
  lostContact: boolean;
  lastUpdated: number | null;
  onReset: () => void;
}) {
  if (lostContact) {
    return (
      <div className="mt-4">
        <p className="text-sm text-[var(--error)]">
          Lost contact with the reassign job. It keeps running in the background; reopen this page to
          check on it.
        </p>
        <button type="button" className={`${btnSecondaryCls} mt-3`} onClick={onReset}>
          Start another
        </button>
      </div>
    );
  }
  if (!progress) {
    return <p className="mt-4 text-sm text-fg-muted">Starting the move…</p>;
  }

  const { summary, actionable } = progress;
  const c = summary.counts;
  const finished = summary.total - c.pending;
  const pct = summary.total === 0 ? 100 : Math.round((finished / summary.total) * 100);

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <p className="pn-h4">{summary.done ? "Move complete" : "Moving…"}</p>
        <Pill variant={summary.done ? "status-ok" : "outline"}>{summary.done ? "Done" : `${pct}%`}</Pill>
      </div>

      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-fg/10" role="progressbar" aria-valuenow={pct}>
        <div className="h-full bg-pennie-sky" style={{ width: `${pct}%` }} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {(["moved", "unplaceable", "skipped", "failed", "pending"] as const).map((k) =>
          c[k] > 0 || k === "moved" ? (
            <div key={k} className="flex items-center justify-between">
              <dt className="text-fg-muted">{STATUS_LABEL[k]}</dt>
              <dd className="tabular-nums text-fg">{c[k]}</dd>
            </div>
          ) : null,
        )}
      </dl>

      {!summary.done && (
        <p className="mt-2 text-xs text-fg-muted" aria-live="polite">
          Working through {summary.total} booking{summary.total === 1 ? "" : "s"}, one at a time
          {lastUpdated ? `. Last update ${formatAgo(lastUpdated)}.` : "…"}
        </p>
      )}

      {actionable.length > 0 && (
        <div className="mt-5">
          <p className="pn-eyebrow text-fg-muted">Couldn&apos;t place ({actionable.length})</p>
          <p className="mt-1 text-xs text-fg-muted">
            No available advisor was free at these times. Open each one to place it by hand (you can
            override the pool or daily cap there).
          </p>
          <ul className="mt-3 divide-y divide-border">
            {actionable.map((it) => (
              <ActionableRow key={it.bookingId} item={it} />
            ))}
          </ul>
        </div>
      )}

      {summary.done && (
        <button type="button" className={`${btnSecondaryCls} mt-4`} onClick={onReset}>
          Start another
        </button>
      )}
    </div>
  );
}

function ActionableRow({ item }: { item: BulkReassignActionableItem }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="min-w-0">
        <span className="block truncate text-fg">
          {item.attendeeName ?? "Booking"}
          {item.startsAt ? ` · ${formatSlotTime(item.startsAt)}` : ""}
        </span>
        {item.detail && <span className="block truncate text-xs text-fg-muted">{item.detail}</span>}
      </span>
      <a
        href={`/admin/bookings/${item.bookingId}`}
        className="shrink-0 text-pennie-blue underline dark:text-pennie-sky"
      >
        Place by hand
      </a>
    </li>
  );
}

/** A coarse "N seconds/minutes ago" for the last-updated heartbeat. */
function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
