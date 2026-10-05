"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { SelectField } from "@/components/ui/SelectField";
import { allXbcCodes } from "@/lib/xbc";
import { deleteJson, getJson, postJson, REQUEST_TIMEOUT_MS } from "@/lib/http";
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
} from "@/lib/booking/reroute-copy";

const SECONDARY_CLS = "min-h-9 rounded-md border border-border px-3 py-1 text-xs text-fg disabled:opacity-60";
const PRIMARY_CLS = "pn-btn pn-btn--primary min-h-9 rounded-md px-3 py-1 text-xs disabled:opacity-60";
const LABEL_CLS = "mb-1 block text-xs text-fg-muted";
const UNREACHABLE = "Slate could not reach the server. Please try again.";

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
}: {
  bookingId: string;
  /** The booking's stored bucket code; a manager's choice keeps the rest of it (R6). */
  currentCode: string | null;
  /** Admins read and pick codes; managers and team leads read pool names. */
  showCodes: boolean;
  /** A move or keep landed: the page re-reads the booking. */
  onChanged: () => void;
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

  // A reload restores a live hold, so the confirm and its countdown survive it.
  useEffect(() => {
    let live = true;
    getJson<{ proposal?: RerouteProposal | null }>(base, { timeoutMs: REQUEST_TIMEOUT_MS }).then((r) => {
      if (live && r.ok && r.data.proposal) setShown({ kind: "proposal", proposal: r.data.proposal, receivedAt: Date.now() });
    });
    return () => {
      live = false;
    };
  }, [base]);

  async function run<T>(request: () => Promise<{ ok: boolean; status: number; data: T & { error?: string } }>, onOk: (data: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await request();
      if (r.ok) onOk(r.data);
      else setError(r.status === 0 ? UNREACHABLE : (r.data.error ?? UNREACHABLE));
    } finally {
      setBusy(false);
    }
  }

  function find() {
    return run<RerouteProposal>(
      () => postJson(base, { bucketCode: chosenCode }, { timeoutMs: REQUEST_TIMEOUT_MS }),
      (proposal) => {
        setNote("");
        setShown({ kind: "proposal", proposal, receivedAt: Date.now() });
      },
    );
  }

  const proposal = shown?.kind === "proposal" ? shown.proposal : shown?.kind === "taken" ? shown.outcome.proposal : null;

  function confirm() {
    if (!proposal || proposal.kind === "none") return;
    const body =
      proposal.kind === "move"
        ? { holdId: proposal.holdId, note: note.trim() || null }
        : {
            holdId: null,
            bucketCode: proposal.bucket.code,
            requestedBucketCode: proposal.requested.code,
            rungsDropped: proposal.rungsDropped,
            note: note.trim() || null,
          };
    const heldAdvisor = proposal.kind === "move" ? proposal.advisor.name : null;
    return run<RerouteOutcome>(
      () => postJson(`${base}/confirm`, body, { timeoutMs: REQUEST_TIMEOUT_MS }),
      (outcome) => {
        if (outcome.kind === "taken") setShown({ kind: "taken", outcome, receivedAt: Date.now() });
        else if (outcome.kind === "expired") setShown({ kind: "expired", heldAdvisor });
        else {
          setShown({ kind: "done", outcome });
          onChanged();
        }
      },
    );
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
              <span id={`${ids}-code`} className={LABEL_CLS}>
                Correct bucket
              </span>
              <SelectField
                className="w-full"
                ariaLabel="Correct bucket"
                value={adminCode}
                options={codes.map((c) => ({ value: c, label: c }))}
                onChange={setAdminCode}
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
                        onChange={() => setBackend(b.key)}
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
                onChange={(v) => setDebt(v as ManagerDebtDigit)}
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
            {(copy.primary || copy.cancel) && (
              <div className="mt-3 flex gap-2">
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
