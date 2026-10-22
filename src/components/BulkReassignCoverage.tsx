"use client";

import { useEffect, useState } from "react";

import type { ReasonOption } from "@/lib/booking/core";
import type { BulkReassignProgress } from "@/lib/booking/bulk-reassign";
import { isBulkReassignProgress } from "@/lib/booking/bulk-reassign";
import { MoveOutcomeRow } from "@/components/MoveOutcomeRow";
import {
  moveOutcomeSentence,
  moveProgressLabel,
  moveSegments,
  isMoveStalled,
  type MoveMark,
} from "@/lib/booking/move-progress";
import {
  COVERAGE_PANEL_NAME,
  coverageCouldNotPlaceHeading,
  coverageMoveMayStart,
  coverageNothingMovedNotice,
  coverageNothingToMoveSentence,
  coveragePanelDescription,
  coveragePanelTimeOffNote,
  coveragePreviewLine,
  coverageProgressUnreadableNotice,
  type CoveragePreviewState,
} from "@/lib/booking/coverage-panel-copy";
import { getJson, postJson } from "@/lib/http";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
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

/**
 * How each outcome is drawn (#2122). Three, not two, and the third is why the
 * mark used to disagree with its own counts: a skip is not a failure.
 *
 * NOT SKY anywhere. Sky is the only colour that may mean "do this" and a progress
 * mark is not an action. Green Mark is the one green in the palette legible with
 * no word beside it (3.57:1 on a white card); the dark theme uses the palette
 * green, which its own record scopes to that side. Rose is the palette's error
 * colour, drawn as an outline so a run of them does not become a red block.
 * A skip takes the quiet letter tone, which is the ledger's own turned-down mark:
 * it carries rhythm and extent rather than an identity, which is exactly what a
 * booking nobody has to act on is.
 */
const MARK_CLASS: Record<MoveMark, string> = {
  moved: "bg-[var(--pennie-green-mark)] dark:bg-[var(--pennie-green)]",
  attention:
    "bg-[color-mix(in_srgb,var(--error)_10%,transparent)] ring-2 ring-inset ring-[var(--error)]",
  skipped: "bg-[var(--ledger-off)]",
  // The one being worked on. The ONLY motion on the screen, and it stops on its
  // own when the run ends, because a finished row has nothing left to say.
  next: "bg-[var(--ledger-off)] animate-pulse motion-reduce:animate-none",
  waiting: "bg-[var(--pennie-mercury)] dark:bg-[var(--ledger-off)]",
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

  /**
   * The count, and how it was obtained, as ONE value (L544). It was a number or
   * null beside a loading flag, and null meant three different things: nobody has
   * asked yet, the read failed, and the reply could not be read. The last of those
   * showed the reader "Enter a range" when they had entered one (L10, L11).
   */
  const [preview, setPreview] = useState<CoveragePreviewState>({ kind: "unasked" });
  /**
   * How many times the reader has asked for the count again (#2157).
   *
   * The count is debounced on the RANGE, so a read that failed has no second
   * attempt unless the dates change: "try again in a moment" named an action
   * nothing would carry out (L111). Since an unreadable count now REFUSES the
   * move, the refusal owes a way out that is not "edit the range you meant".
   */
  const [countAttempt, setCountAttempt] = useState(0);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [progress, setProgress] = useState<BulkReassignProgress | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  /**
   * A progress reply that ARRIVED and could not be read (#2135). Its own state,
   * beside running and lost contact: a reply that never came and a reply that did
   * not fit are different facts with different remedies, and neither is a blank
   * (L10, L11).
   */
  const [unreadable, setUnreadable] = useState(false);
  /**
   * Did the reader start this move on this panel, or arrive on one somebody else
   * enqueued (#2136)? A time off approval enqueues a sweep and the Team Time Off
   * row links straight to it, so on that arrival nobody chose the range, and the
   * two arrivals owe different sentences and different controls.
   */
  const [startedHere, setStartedHere] = useState(false);
  /** A move started here that moved nothing, said on the form rather than on a
   *  screen of its own (#2142). */
  const [nothingMoved, setNothingMoved] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  /**
   * How many consecutive polls have come back with the SAME settled count
   * (#2122). The stall signal is the work advancing, not the request returning:
   * a poll that succeeds over a drain that has stopped is a live emitter over
   * dead work (L106).
   */
  const [unchangedPolls, setUnchangedPolls] = useState(0);

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
      setPreview({ kind: "counting" });
      const res = await getJson<{ count?: unknown }>(`${base}?${params.toString()}`).catch(() => null);
      if (cancelled) return;
      // The same shape question the poll asks (#2135), swept for in this file's
      // own diff: a count that is not a number would otherwise reach the reader
      // inside a sentence, and would enable the button by failing the `=== 0`
      // test. A read that failed and a reply that could not be counted are the
      // same fact to a reader, which is that nobody knows the number.
      const raw = res && res.ok ? res.data?.count : undefined;
      const next: CoveragePreviewState =
        typeof raw === "number" && Number.isFinite(raw)
          ? { kind: "count", count: raw }
          : { kind: "unreadable" };
      setPreview(next);
      // The "nothing moved" line stands only while the range really does hold
      // nothing. The moment a count disagrees with it, the count is the more
      // useful of the two and takes the line back, so the panel never shows an
      // outcome that the number beside it would contradict.
      if (next.kind === "count" && next.count !== 0) setNothingMoved(false);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `countAttempt` is in the deps so Count again really re-reads (#2157). Without
    // it the button would be a control that looks like it did something.
  }, [base, from, to, jobId, countAttempt]);

  // Poll while a job is running and not yet done. The fetch lives in the effect
  // (like useFetchList) so setState only happens after an await, never
  // synchronously in the effect body.
  const done = progress?.summary.done ?? false;
  useEffect(() => {
    if (!jobId || done) return;
    let cancelled = false;
    const tick = async () => {
      // Deliberately `unknown` (#2135). `getJson<BulkReassignProgress>` was a
      // promise about a body nothing had read: a 200 of the wrong shape threw
      // during render and the admin page's error boundary blanked the WHOLE page.
      // Typing it unknown makes `tsc` refuse to let this be used as progress
      // until the predicate has said it is.
      const res = await getJson<unknown>(`${base}?jobId=${encodeURIComponent(jobId)}`).catch(
        () => null,
      );
      if (cancelled) return;
      if (res && res.ok && isBulkReassignProgress(res.data)) {
        const next = res.data;
        /**
         * A move the reader started HERE that had nothing to move is the FORM's
         * own state, not a screen (#2142).
         *
         * The old screen said "Nothing to move" and offered `Start another`, and
         * `another` was the one word in it carrying meaning: the run placed
         * nothing and touched no booking, so nothing had been started. Worse, it
         * stated a fact about the range and then took away the two controls that
         * change it. Back on the form those controls are under the reader's hand
         * and the count re-reads as they are edited.
         *
         * A sweep the reader ARRIVED on keeps its screen, because there is no
         * form state that corresponds to a window somebody else chose (#2136).
         */
        if (startedHere && next.summary.total === 0) {
          setJobId(null);
          setProgress(null);
          setPollFailures(0);
          setLastUpdated(null);
          setUnreadable(false);
          setStartedHere(false);
          setNothingMoved(true);
          return;
        }
        setProgress((prev) => {
          const settled = (p: BulkReassignProgress) => p.summary.total - p.summary.counts.pending;
          setUnchangedPolls((n) => (prev && settled(prev) === settled(next) ? n + 1 : 0));
          return next;
        });
        setLastUpdated(Date.now());
        setPollFailures(0);
        setUnreadable(false);
      } else if (res && res.ok) {
        // The reply arrived; it is not progress. Polling continues, because a
        // page that is merely older than the server recovers on its own once the
        // shapes line up again, and the panel says so rather than going blank.
        setUnreadable(true);
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
  }, [base, jobId, done, startedHere]);

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
    setUnreadable(false);
    setNothingMoved(false);
    setStartedHere(true);
    setJobId(res.data.jobId);
  }

  function reset() {
    setJobId(null);
    setProgress(null);
    setError(null);
    setPollFailures(0);
    setLastUpdated(null);
    setUnreadable(false);
    setStartedHere(false);
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
              <>
                <label className="sr-only" htmlFor="bulk-reason-detail">
                  Tell us a bit more
                </label>
                <input
                  id="bulk-reason-detail"
                  type="text"
                  className={`${inputCls} mt-2`}
                  placeholder="Tell us a bit more"
                  value={reasonDetail}
                  maxLength={500}
                  onChange={(e) => setReasonDetail(e.target.value)}
                />
              </>
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

          {/* One line, which is the count until a run has something to report
              about itself, and then the outcome (#2142). Two lines would state
              the same fact twice on one surface (L605). */}
          <p className="mt-4 text-sm text-fg" aria-live="polite">
            {nothingMoved ? coverageNothingMovedNotice(agentName) : coveragePreviewLine(preview)}
          </p>

          {/* The way out of the refusal (#2157). Only on the state that refuses,
              because a retry offered beside a working count is a control with
              nothing to do. Secondary, since the reader's next move is to get the
              count back rather than to press the primary action. */}
          {preview.kind === "unreadable" && (
            <div className="mt-3">
              <button
                type="button"
                className={btnSecondaryCls}
                onClick={() => setCountAttempt((n) => n + 1)}
              >
                Count again
              </button>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-[var(--error)]">{error}</p>}

          <button
            type="button"
            className={`${btnCls} mt-4 disabled:cursor-not-allowed disabled:opacity-50`}
            /* #2157: ONE predicate, shared with the line above, rather than a list
               of states assembled here. It used to enumerate the states that may
               not start, so "the count could not be read" inherited permission from
               nobody having thought about it, and a manager could move real
               customers' appointments without knowing how many. */
            disabled={
              starting ||
              !coverageMoveMayStart(preview) ||
              (reasonCode === "other" && !reasonDetail.trim())
            }
            onClick={start}
          >
            {starting ? "Starting…" : "Move these bookings"}
          </button>
        </>
      ) : (
        <Progress
          agentName={agentName}
          progress={progress}
          lostContact={lostContact}
          unreadable={unreadable}
          lastUpdated={lastUpdated}
          unchangedPolls={unchangedPolls}
          onReset={reset}
        />
      )}
    </section>
  );
}

function Progress({
  agentName,
  progress,
  lostContact,
  unreadable,
  lastUpdated,
  unchangedPolls,
  onReset,
}: {
  agentName: string;
  progress: BulkReassignProgress | null;
  lostContact: boolean;
  /** A reply arrived and was not progress (#2135). */
  unreadable: boolean;
  lastUpdated: number | null;
  /** Consecutive polls that returned the same settled count. */
  unchangedPolls: number;
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
  // #2135. Checked BEFORE the "starting" line, because a reply that arrived and
  // did not fit is not a move that has yet to report: leaving it under the
  // spinner is the blank this issue is about, one state further along.
  if (unreadable) {
    return (
      <div className="mt-4">
        <p className="text-sm text-[var(--error)]">{coverageProgressUnreadableNotice()}</p>
        <button
          type="button"
          className={`${btnSecondaryCls} mt-3`}
          onClick={() => window.location.reload()}
        >
          Reload the page
        </button>
      </div>
    );
  }
  if (!progress) {
    return <p className="mt-4 text-sm text-fg-muted">Starting the move…</p>;
  }

  const { summary, actionable, skipped } = progress;
  // #3615: a demotion sweep's moved calls. Absent from an older server's reply, which reads as none.
  const moved = progress.moved ?? [];
  const mark = moveSegments(summary);
  const said = moveOutcomeSentence(summary);
  const label = moveProgressLabel(summary);

  // #2122: NOTHING TO MOVE IS ITS OWN SCREEN, and it is the p0.
  //
  // This used to draw a finished bar over zero work (`pct = total === 0 ? 100`),
  // with a green Done pill and the heading "Move complete" beside a figure
  // reading "Moved 0". A completed bar and a count of nothing contradict each
  // other, the bar was the loudest thing on the panel, and nothing said what had
  // actually happened, which is that this agent had no upcoming bookings. It is
  // also the state an admin lands on straight from a time off approval, which is
  // exactly when somebody needs to know whether coverage happened.
  if (summary.total === 0) {
    return (
      <div className="mt-4">
        <p className="pn-h4">Nothing to move</p>
        <p className={`mt-2 text-sm text-fg-muted ${proseCls}`}>
          {coverageNothingToMoveSentence(agentName, progress.job.range_start, progress.job.range_end)}
        </p>
        {/* NOT "Start another" (#2142). Whoever is reading this arrived on a sweep
            somebody else enqueued, so they have started nothing to start again. */}
        <button type="button" className={`${btnSecondaryCls} mt-4`} onClick={onReset}>
          Start a move
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <p className="pn-h4">{summary.done ? "Move complete" : "Moving"}</p>

      {/* The mark carries the proportion and NOTHING repeats it: no percentage
          pill, no "x of y" on the headline row. A mark beside its own caption
          cannot earn its place, which is the rule the tier ledger already
          learned (#1812).

          One segment per booking, so the unit of the mark is the unit of the
          work. Nothing lands as it arrives: at 40 arriving one after another any
          landing with geometry in it reads as the whole row twitching. The one
          being worked on breathes instead, and it is the only thing moving on the
          screen, which is the single thing a still row cannot say (a stalled poll
          and a slow one are otherwise the same picture).

          NOT SKY. Sky is the only colour that may mean "do this" and a progress
          mark is not an action. Green for moved, rose for the ones a person still
          has to place, and the quiet letter tone for a skip, which is neither. */}
      {mark && label && (
        <div
          className="mt-3"
          role="progressbar"
          aria-valuemin={label.min}
          aria-valuemax={label.max}
          aria-valuenow={label.now}
          aria-valuetext={label.text}
          aria-label={label.text}
        >
          {mark.kind === "segments" ? (
            <div
              className="flex h-3.5"
              style={{ gap: mark.marks.length > 8 ? "2px" : "4px" }}
            >
              {mark.marks.map((m, i) => (
                <span key={i} className={`flex-1 rounded-[2px] ${MARK_CLASS[m]}`} />
              ))}
            </div>
          ) : (
            // Above 60 a segment is about 6.5px on this card and the row reads as
            // a hatched texture rather than a proportion, so it becomes one fill,
            // which says the same thing at any count.
            <div className="h-3.5 w-full overflow-hidden rounded-[2px] bg-[var(--pennie-mercury)] dark:bg-[var(--ledger-off)]">
              <div
                className="h-full bg-[var(--pennie-green-mark)] transition-[width] duration-300 ease-out motion-reduce:transition-none dark:bg-[var(--pennie-green)]"
                style={{ width: `${(mark.settled / mark.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* The counts, once, as a line a person would say. While it runs it carries
          no full stop, because it is a reading rather than a sentence and a stop
          on it makes an unfinished thing look finished. Each exception is counted
          here and explained on its own row below, so the reason is on the screen
          once. */}
      <p className="mt-3 text-sm text-fg-muted" aria-live="polite">
        <span className="tabular-nums">{said}</span>
      </p>

      {/* The only note left is the one the mark cannot give: that the job has
          stopped reporting. "One at a time" was obvious from watching it and
          "N to go" was the count again. */}
      {isMoveStalled(unchangedPolls, summary.done) && (
        <p className="mt-2 text-xs text-fg-muted" aria-live="polite">
          Nothing has moved for a while. It keeps running in the background
          {lastUpdated === null ? "" : `, last checked ${formatAgo(lastUpdated)}`}.
        </p>
      )}

      {/* #2122: the instruction is gone and the rows carry it. Dan, on the design
          round: "this is an instruction with no way to complete. how does the
          manager find them". Every row already says Place by hand on it, so a
          sentence above them telling somebody to open each one states the same
          thing a third time, after the count and before the control that does it. */}
      {actionable.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="pn-eyebrow text-fg-muted">{coverageCouldNotPlaceHeading(actionable.length)}</p>
          <ul className="mt-2 divide-y divide-border">
            {actionable.map((it) => (
              <MoveOutcomeRow key={it.bookingId} item={it} />
            ))}
          </ul>
        </div>
      )}

      {/* #3615: the calls an automatic demotion reroute moved, after the ones in trouble and
          before the ones nobody can act on. Nothing else tells a person which calls it moved,
          and each row links to the booking, where the move back is. */}
      {moved.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="pn-eyebrow text-fg-muted">Moved ({moved.length})</p>
          <ul className="mt-2 divide-y divide-border">
            {moved.map((it) => (
              <MoveOutcomeRow key={it.bookingId} item={it} />
            ))}
          </ul>
        </div>
      )}

      {/* #2122: the skips, which used to be a bare number nobody could act on.
          Dan, meeting it: "now it says nothing about the skipped one. what am I
          supposed to do about that". The answer is nothing, and that is why the
          count alone was unreadable. Each row carries the engine's own reason
          ("Booking no longer exists", "Booking was cancelled before it could be
          moved"), and NO control, because offering one would imply there is
          something to press. */}
      {skipped.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="pn-eyebrow text-fg-muted">Skipped ({skipped.length})</p>
          <ul className="mt-2 divide-y divide-border">
            {skipped.map((it) => (
              <MoveOutcomeRow key={it.bookingId} item={it} />
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

/** A coarse "N seconds/minutes ago" for the last-updated heartbeat. */
function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
