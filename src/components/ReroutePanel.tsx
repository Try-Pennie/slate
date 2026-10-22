"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { SelectField } from "@/components/ui/SelectField";
import { allXbcCodes } from "@/lib/xbc";
import { deleteJson, getJson, postJson, REQUEST_TIMEOUT_MS, type PostJsonResult } from "@/lib/http";
import { useStalledAfter } from "@/lib/useStalledAfter";
import type { RerouteOutcome, RerouteProposal } from "@/lib/booking/reroute";
import {
  MANAGER_BACKENDS,
  MANAGER_DEBT_LEVELS,
  composeManagerCode,
  heldFor,
  managerChoiceFromCode,
  outcomeCopy,
  proposalCopy,
  type ManagerBackend,
  type ManagerDebtDigit,
  type RerouteCopy,
  REROUTE_UNREACHABLE,
  REROUTE_TIMED_OUT,
  rerouteFailed,
} from "@/lib/booking/reroute-copy";

const SECONDARY_CLS = "min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg disabled:opacity-60";
const PRIMARY_CLS = "pn-btn pn-btn--primary min-h-9 rounded-md px-3 py-1 text-xs disabled:opacity-60";
const LABEL_CLS = "mb-1 block text-xs text-fg-muted";

/** What the result column is showing. */
type Shown =
  | { kind: "proposal"; proposal: RerouteProposal; receivedAt: number }
  | { kind: "taken"; outcome: Extract<RerouteOutcome, { kind: "taken" }>; receivedAt: number }
  | { kind: "expired"; heldAdvisor: string | null }
  | { kind: "done"; outcome: Extract<RerouteOutcome, { kind: "moved" | "kept" }> };

/**
 * Reroute a booking into a corrected bucket (#3250, phase 4 of #3244), built to the
 * design settled with Dan on 2026-10-04 (`docs/design/reroute-panel.html`, R1 to
 * R17 on #3250): the choice on the left, the result on the right; an explicit "Find
 * an advisor"; the tier drop leading the result. An admin picks from the sixty
 * codes, a manager picks a backend then a debt level (R4, R5), and every sentence
 * comes from `reroute-copy` so codes and pool names follow the viewer (R7).
 */
export default function ReroutePanel({
  bookingId,
  currentCode,
  showCodes,
  onChanged,
  onReassign,
}: {
  bookingId: string;
  /** The booking's stored bucket code; a manager's choice keeps the rest of it (R6). */
  currentCode: string | null;
  /** Admins read and pick codes; managers and team leads read pool names. */
  showCodes: boolean;
  /** A move or keep landed: the page re-reads the booking. */
  onChanged: () => void;
  /**
   * Opens the booking's own Reassign picker (#4043), offered when nobody is free.
   * Required, so the page that holds the picker decides, and no second picker is
   * built here.
   */
  onReassign: () => void;
}) {
  const ids = useId();
  const codes = useMemo(() => allXbcCodes(), []);
  const [adminCode, setAdminCode] = useState(() => (currentCode && codes.includes(currentCode) ? currentCode : codes[0]));
  const initial = useMemo(() => managerChoiceFromCode(currentCode), [currentCode]);
  const [debt, setDebt] = useState<ManagerDebtDigit>(initial.debt);
  const [backend, setBackend] = useState<ManagerBackend>(initial.backend);
  const [note, setNote] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const stalled = useStalledAfter(busy);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(shown?.kind === "proposal" || shown?.kind === "taken");

  const chosenCode = showCodes ? adminCode : composeManagerCode(currentCode, debt, backend);
  const base = `/api/admin/bookings/${bookingId}/reroute`;
  const proposal = shown?.kind === "proposal" ? shown.proposal : shown?.kind === "taken" ? shown.outcome.proposal : null;

  // A reload restores a live hold, so the confirm and its countdown survive it. Once
  // the admin has acted, a restore landing late is older than what they asked for,
  // and replacing it would offer a hold their own search already replaced.
  const acted = useRef(false);
  useEffect(() => {
    let live = true;
    getJson<{ proposal?: RerouteProposal | null }>(base, { timeoutMs: REQUEST_TIMEOUT_MS }).then((r) => {
      if (live && !acted.current && r.ok && r.data.proposal) {
        setShown({ kind: "proposal", proposal: r.data.proposal, receivedAt: Date.now() });
      }
    });
    return () => {
      live = false;
    };
  }, [base]);

  // Closing the panel (another action, or leaving the page in app) lets go of an
  // advisor it is holding, so they are free for leads now rather than when the hold
  // runs out. A confirm in flight keeps its hold: the server releases it if the
  // confirm fails. A reload runs no cleanup, so the hold and its countdown survive it.
  const open = useRef(true);
  const holding = useRef(false);
  const confirming = useRef(false);
  useEffect(() => {
    holding.current = (shown?.kind === "proposal" || shown?.kind === "taken") && proposal?.kind === "move";
  });
  useEffect(() => {
    const state = { open, holding, confirming };
    state.open.current = true;
    return () => {
      state.open.current = false;
      if (state.holding.current && !state.confirming.current) release();
    };
    // release reads only base, which is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  function release() {
    void deleteJson(`${base}/hold`, { timeoutMs: REQUEST_TIMEOUT_MS });
  }

  async function run<T>(request: () => Promise<PostJsonResult<T & { error?: string }>>, onOk: (data: T) => void) {
    acted.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await request();
      if (r.ok) onOk(r.data);
      // No answer in time is not an unreachable server (#3307): the work may still
      // land, so the reader is sent to reload rather than to press again.
      else if (r.status === 0) setError(r.timedOut ? REROUTE_TIMED_OUT : REROUTE_UNREACHABLE);
      else setError(r.data.error ?? rerouteFailed(r.status));
    } finally {
      setBusy(false);
    }
  }

  // `excludeCurrent` is "look for a different advisor" (#3596): the only thing the body
  // says is to leave out the current advisor; the server resolves which id that is from
  // the booking, so the panel cannot name an arbitrary exclusion.
  function runFind(excludeCurrent: boolean) {
    return run<RerouteProposal>(
      () =>
        postJson(
          base,
          excludeCurrent ? { bucketCode: chosenCode, excludeCurrent: true } : { bucketCode: chosenCode },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        ),
      (proposal) => {
        // A search that lands after the panel closed holds somebody nobody will confirm.
        if (!open.current) {
          if (proposal.kind === "move") release();
          return;
        }
        setNote("");
        setShown({ kind: "proposal", proposal, receivedAt: Date.now() });
      },
    );
  }

  // Named rather than bound inline so an onClick's MouseEvent is never passed in as the
  // excludeCurrent flag.
  function find() {
    return runFind(false);
  }
  function findDifferent() {
    return runFind(true);
  }


  function confirm() {
    if (!proposal || proposal.kind === "none") return;
    const body =
      proposal.kind === "move"
        ? { holdId: proposal.holdId, note: note.trim() || null }
        : {
            holdId: null,
            bucketCode: proposal.bucket.code,
            requestedBucketCode: proposal.requested.code,
            note: note.trim() || null,
          };
    const heldAdvisor = proposal.kind === "move" ? proposal.advisor.name : null;
    confirming.current = true;
    return run<RerouteOutcome>(
      () => postJson(`${base}/confirm`, body, { timeoutMs: REQUEST_TIMEOUT_MS }),
      (outcome) => {
        // A search the confirm re-ran after the panel closed holds somebody nobody
        // will confirm, the same as a late search.
        if (outcome.kind === "taken" && !open.current) {
          if (outcome.proposal.kind === "move") release();
          return;
        }
        if (outcome.kind === "taken") setShown({ kind: "taken", outcome, receivedAt: Date.now() });
        else if (outcome.kind === "expired") setShown({ kind: "expired", heldAdvisor });
        else {
          setShown({ kind: "done", outcome });
          onChanged();
        }
      },
    ).finally(() => {
      confirming.current = false;
    });
  }

  /**
   * A new choice makes the result on screen the answer to a different question, so
   * it goes, and an advisor it was holding is let go (the same as Cancel). Picking
   * what is already chosen changes nothing, and keeps both.
   */
  function choose(changed: boolean, apply: () => void) {
    if (!changed) return;
    apply();
    if (shown?.kind === "proposal" || shown?.kind === "taken") {
      const held = proposal?.kind === "move";
      setShown(null);
      setError(null);
      // Through `run`, so the panel is busy until it lands: the release frees the
      // booking's hold whatever it is, and one landing after a new search had held
      // somebody would free that hold instead.
      if (held) void run(() => deleteJson(`${base}/hold`, { timeoutMs: REQUEST_TIMEOUT_MS }), () => {});
    }
  }

  async function cancel() {
    // Only a move holds anybody; letting it go frees that advisor for leads now
    // rather than when the hold runs out.
    if (proposal?.kind === "move") {
      await run(() => deleteJson(`${base}/hold`, { timeoutMs: REQUEST_TIMEOUT_MS }), () => setShown(null));
    } else {
      setShown(null);
      setError(null);
    }
  }

  const copy: RerouteCopy | null = !shown
    ? null
    : shown.kind === "proposal"
      ? proposalCopy(shown.proposal, showCodes)
      : shown.kind === "taken"
        ? outcomeCopy(shown.outcome, showCodes, null)
        : shown.kind === "expired"
          ? outcomeCopy({ kind: "expired" }, showCodes, shown.heldAdvisor)
          : outcomeCopy(shown.outcome, showCodes, null);

  const secondsLeft =
    (shown?.kind === "proposal" || shown?.kind === "taken") && proposal?.kind === "move"
      ? proposal.secondsRemaining - Math.floor(Math.max(0, now - shown.receivedAt) / 1000)
      : null;

  return (
    <div className="mt-3 border-t border-border pt-4">
      <div className="grid gap-5 md:grid-cols-[300px_1fr] md:items-start">
        <div>
          {showCodes ? (
            <>
              <span className={LABEL_CLS}>
                Correct bucket
              </span>
              <SelectField
                className="w-full"
                ariaLabel="Correct bucket"
                value={adminCode}
                options={codes.map((c) => ({ value: c, label: c }))}
                onChange={(v) => choose(v !== adminCode, () => setAdminCode(v))}
                disabled={busy}
              />
            </>
          ) : (
            <>
              <fieldset>
                <legend className={LABEL_CLS}>Backend</legend>
                <div className="flex overflow-hidden rounded-md border border-border">
                  {MANAGER_BACKENDS.map((b) => (
                    <label key={b.key} className="flex-1 cursor-pointer border-l border-border first:border-l-0">
                      <input
                        type="radio"
                        name={`${ids}-backend`}
                        value={b.key}
                        checked={backend === b.key}
                        onChange={() => choose(b.key !== backend, () => setBackend(b.key))}
                        disabled={busy}
                        className="peer sr-only"
                      />
                      <span className="flex min-h-9 items-center justify-center px-2 text-xs text-fg peer-checked:bg-pennie-sky peer-checked:font-semibold peer-checked:text-pennie-graphite peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--focus-ring-line)]">
                        {b.label}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <span className={`${LABEL_CLS} mt-3`}>Debt level</span>
              <SelectField
                className="w-full"
                ariaLabel="Debt level"
                value={debt}
                options={MANAGER_DEBT_LEVELS.map((d) => ({ value: d.digit, label: d.label }))}
                onChange={(v) => choose(v !== debt, () => setDebt(v as ManagerDebtDigit))}
                disabled={busy}
              />
            </>
          )}
          <div className="mt-3">
            <button type="button" onClick={find} disabled={busy} className={SECONDARY_CLS}>
              Find an advisor
            </button>
          </div>
        </div>

        {copy && (
          <div className="rounded-md border border-border p-4" aria-live="polite">
            <h3 className="text-sm font-semibold text-fg">{copy.heading}</h3>
            <p className={`mt-1 text-sm ${shown?.kind === "done" ? "text-fg-muted" : "text-fg"}`} role={shown?.kind === "done" ? "status" : undefined}>
              {copy.body}
            </p>
            {copy.held && secondsLeft !== null && <p className="mt-1 text-sm tabular-nums text-fg-muted">{heldFor(secondsLeft)}</p>}
            {copy.note && (
              <div className="mt-3">
                <label htmlFor={`${ids}-note`} className={LABEL_CLS}>
                  Note
                </label>
                <input
                  id={`${ids}-note`}
                  type="text"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional"
                  disabled={busy}
                  className="min-h-9 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg"
                />
              </div>
            )}
            {(copy.primary || copy.cancel || copy.reassign) && (
              <div className="mt-3 flex gap-2">
                {/* #4043: nobody is free, so the way forward is the booking's own
                    Reassign picker, which this hands over to rather than copying. */}
                {copy.reassign && (
                  <button type="button" onClick={onReassign} disabled={busy} className={SECONDARY_CLS}>
                    {copy.reassign}
                  </button>
                )}
                {copy.primary && (
                  <button
                    type="button"
                    onClick={shown?.kind === "expired" ? find : confirm}
                    disabled={busy}
                    className={PRIMARY_CLS}
                  >
                    {copy.primary}
                  </button>
                )}
                {/* On a keep, the current advisor can technically take the call but you
                    may want it moved off them (#3596). Re-run excluding them, which
                    becomes a move to the next eligible advisor or an honest "nobody
                    else is free". */}
                {shown?.kind === "proposal" && proposal?.kind === "keep" && (
                  <button type="button" onClick={findDifferent} disabled={busy} className={SECONDARY_CLS}>
                    Look for a different advisor
                  </button>
                )}
                {copy.cancel && (
                  <button type="button" onClick={cancel} disabled={busy} className={SECONDARY_CLS}>
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {busy && stalled && !error && (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          Still working… this is taking longer than usual.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** The current time, ticking once a second while `running`, for the hold countdown. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [running]);
  return now;
}
