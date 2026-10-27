"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { lookupCoordinatorCustomer, placeCoordinatorCall } from "@/app/coordinator/actions";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import { SelectField } from "@/components/ui/SelectField";
import { WarningNotice } from "@/components/ui/WarningNotice";
import { MarkedLabel } from "@/components/ui/MarkedLabel";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { SubmitPending } from "@/components/ui/SubmitButton";
import { COORDINATOR_PAGE_COPY as COPY } from "@/lib/coordinator/booking-page-copy";
import {
  pageView,
  placeRequest,
  reducePage,
  type LookupAnswer,
  type PageState,
  type PlaceAnswer,
} from "@/lib/coordinator/booking-page";
import styles from "./coordinator-booking.module.css";

/** Past this a lookup has stopped being slow and is said as unanswered, with Find to try again. */
const LOOKUP_TIMEOUT_MS = 30_000;
/**
 * Past this a booking is said as unanswered. The press is retried under the same
 * submission id, so the server replays a booking that did go through rather than
 * making a second one (D30).
 */
const PLACE_TIMEOUT_MS = 60_000;
/** How often the customer's clock line is redrawn. */
const CLOCK_TICK_MS = 15_000;

/**
 * BookerStrip's day chip, with the product's disabled look for a Closed day. The chosen
 * chip is Sky with graphite text, which stays graphite in both themes; a chip at rest
 * takes the theme's own text on the card.
 */
const DAY_CHIP =
  "flex min-h-11 min-w-16 flex-1 flex-col items-center rounded-lg border px-3 py-2 tabular-nums transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60";
const DAY_CHIP_CHOSEN = "border-pennie-sky bg-pennie-sky text-pennie-graphite";
const DAY_CHIP_REST = "border-border text-fg hover:border-pennie-sky";

/** Keys that move between or around controls, which are not an attempt on the locked card. */
const NAV_KEYS = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "CapsLock"]);

const TIMED_OUT = Symbol("timed out");
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A submission id for the booking, minted once per customer and kept across retries. */
function mintSubmissionId(): string {
  return crypto.randomUUID();
}

/**
 * The coordinator booking page (#4205), built to docs/design/coordinator-booking.html.
 *
 * Every rule lives in `reducePage` (src/lib/coordinator/booking-page.ts), which this only
 * sends events to; this does what a reducer cannot: calls the two server actions, keeps
 * a clock, and moves focus. `fixedNowMs` holds the clock still, for the design's frames.
 */
export function CoordinatorBooking({
  initial,
  reasons,
  fixedNowMs,
}: {
  initial: PageState;
  /** The product's reschedule reasons a person may choose (`loadReasonOptions`). */
  reasons: readonly { code: string; label: string }[];
  fixedNowMs?: number;
}) {
  const [state, dispatch] = useReducer(reducePage, initial);
  const [nowMs, setNowMs] = useState(() => fixedNowMs ?? Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const view = pageView(state, { nowMs, reasons });

  const leadRef = useRef<HTMLInputElement>(null);
  const toldRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  /** The lookup and booking already sent, so a redraw never sends one twice. */
  const sentLookup = useRef(initial.lookup.seq);
  const sentPlace = useRef(initial.place.seq);
  /** Where focus goes once the next answer is drawn. */
  const focusNext = useRef<"after-lookup" | "lead" | "again" | null>(null);

  // The customer's clock line follows the real clock, unless a frame holds it still.
  useEffect(() => {
    if (fixedNowMs !== undefined) return;
    const t = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(t);
  }, [fixedNowMs]);

  // Still alive: the working state counts up while a lookup or booking runs.
  const busy = state.phase === "finding" || state.phase === "placing";
  useEffect(() => {
    if (!busy || state.startedAt === null) return;
    const started = state.startedAt;
    const t = window.setInterval(() => setElapsedMs(Date.now() - started), 1_000);
    return () => {
      window.clearInterval(t);
      setElapsedMs(0);
    };
  }, [busy, state.startedAt]);

  // The lookup, once per one the reducer started.
  useEffect(() => {
    if (state.phase !== "finding" || state.lookup.seq === sentLookup.current || !state.lookup.leadId) return;
    const seq = state.lookup.seq;
    sentLookup.current = seq;
    withTimeout(lookupCoordinatorCustomer({ reference: state.lookup.leadId }), LOOKUP_TIMEOUT_MS).then(
      (out) => {
        if (out === TIMED_OUT) return dispatch({ type: "lookupNoAnswer", seq });
        const answer: LookupAnswer = out.ok
          ? { ok: true, customer: out.customer, existingCall: out.existingCall, days: out.days }
          : { ok: false, sentence: out.sentence };
        focusNext.current = answer.ok ? "after-lookup" : "lead";
        dispatch({ type: "lookupAnswered", seq, answer });
      },
      // A thrown action (the network, a deploy mid request) is said, never swallowed.
      () => {
        focusNext.current = "lead";
        dispatch({ type: "lookupNoAnswer", seq });
      },
    );
  }, [state.phase, state.lookup]);

  // The booking, once per press the reducer accepted.
  useEffect(() => {
    if (state.phase !== "placing" || state.place.seq === sentPlace.current) return;
    const request = placeRequest(state);
    if (!request) return;
    const seq = state.place.seq;
    sentPlace.current = seq;
    withTimeout(placeCoordinatorCall(request), PLACE_TIMEOUT_MS).then(
      (out) => {
        if (out === TIMED_OUT) return dispatch({ type: "placeNoAnswer", seq });
        let outcome: PlaceAnswer;
        if (out.kind === "booked" || out.kind === "moved") {
          outcome = { kind: out.kind, on: out.on, advisorName: out.advisorName, startsAt: out.startsAt, sentence: out.sentence };
          focusNext.current = "again";
        } else if (out.kind === "needs-confirm") outcome = { kind: out.kind, call: out.call, sentence: out.sentence };
        else if (out.kind === "possible-match") outcome = { kind: out.kind, call: out.call, matchedOn: out.matchedOn, sentence: out.sentence };
        else outcome = { kind: "refused", sentence: out.sentence };
        dispatch({ type: "placeAnswered", seq, outcome });
      },
      () => dispatch({ type: "placeNoAnswer", seq }),
    );
  }, [state]);

  // Focus after an answer: a customer with a call starts at the box that unlocks the card,
  // anyone else at the first day that can be booked; a refusal back at the field.
  useEffect(() => {
    const want = focusNext.current;
    if (!want || busy) return;
    focusNext.current = null;
    if (want === "lead") leadRef.current?.focus();
    else if (want === "again") againRef.current?.focus();
    else if (toldRef.current) toldRef.current.focus();
    else document.querySelector<HTMLButtonElement>("#co-booking [data-day]:not(:disabled)")?.focus();
  });

  const pointToBox = useCallback(() => {
    dispatch({ type: "pointedToBox" });
    toldRef.current?.focus();
    document.getElementById("co-warning")?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }, []);

  const again = () => {
    focusNext.current = "lead";
    dispatch({ type: "again" });
  };

  const b = view.booking;
  const finding = view.lead.finding;

  return (
    <>
      <div className={styles.root}>
        <div className="space-y-8">
          <h1 className="pn-h3 text-fg">{COPY.page.title}</h1>
          {view.done ? (
            <section className={cardCls} role="status" aria-labelledby="co-done-heading">
              <h2 id="co-done-heading" className="text-2xl font-semibold text-fg">
                {view.done.heading}
              </h2>
              <p className="mt-3 text-xl font-semibold text-fg tabular-nums">{view.done.when}</p>
              <p className={`mt-2 text-base text-fg ${proseCls}`}>{view.done.with}</p>
              {view.done.link && <p className={`mt-2 text-base text-fg ${proseCls}`}>{view.done.link}</p>}
              <p className="mt-2 text-sm text-fg-muted">{view.done.by}</p>
              <div className="mt-6">
                <button ref={againRef} id="co-again" type="button" className={btnCls} onClick={again}>
                  {view.done.again}
                </button>
              </div>
            </section>
          ) : (
            <>
              <section className={`${cardCls} ${styles.stack}`}>
                <h2 className="mb-1 text-sm font-semibold">{COPY.customer.heading}</h2>
                <div>
                  <label className={labelCls} htmlFor="co-lead">
                    {COPY.lead.label}
                  </label>
                  <div className={styles.inline}>
                    <input
                      ref={leadRef}
                      id="co-lead"
                      type="text"
                      className={`${inputCls} ${styles.grow}`}
                      value={view.lead.value}
                      autoComplete="off"
                      spellCheck={false}
                      readOnly={finding}
                      aria-invalid={view.lead.refusal ? true : undefined}
                      aria-describedby={view.lead.refusal ? "co-lead-refusal" : undefined}
                      onChange={(e) => dispatch({ type: "leadEdited", value: e.target.value, at: Date.now() })}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        dispatch({ type: "findPressed", at: Date.now() });
                      }}
                    />
                    <button
                      id="co-find"
                      type="button"
                      className={`${btnSecondaryCls} mt-1 ${styles.noshrink}`}
                      aria-disabled={finding ? true : undefined}
                      onClick={() => dispatch({ type: "findPressed", at: Date.now() })}
                    >
                      {finding ? <SubmitPending elapsedMs={elapsedMs} pendingLabel={COPY.lead.pending} slowLabel={COPY.more.slow} /> : COPY.lead.find}
                    </button>
                  </div>
                  {view.lead.refusal && (
                    <p id="co-lead-refusal" role="alert" className={`mt-2 text-sm text-error ${proseCls}`}>
                      {view.lead.refusal}
                    </p>
                  )}
                </div>
                {view.customer && (
                  <div>
                    <p className="text-base font-semibold text-fg">{view.customer.name}</p>
                    <dl className={`${styles.details} text-sm`}>
                      <dt className="text-fg-muted">{COPY.customer.phone}</dt>
                      <dd className="text-fg">{view.customer.phone}</dd>
                      <dt className="text-fg-muted">{COPY.customer.zone}</dt>
                      <dd className="text-fg">
                        <span>{view.customer.zone}</span>
                        <span className="block text-fg-muted">{view.customer.clock}</span>
                      </dd>
                    </dl>
                  </div>
                )}
                {view.notice && (
                  <WarningNotice block id="co-warning" labelledBy="co-call-heading">
                    <p id="co-call-heading" className="font-semibold">
                      {view.notice.heading}
                    </p>
                    {view.notice.lines.map((line) => (
                      <p key={line} className="mt-1">
                        {line}
                      </p>
                    ))}
                    {view.notice.told && (
                      <label className="mt-2 -mb-[10px] flex min-h-11 cursor-pointer items-center gap-3">
                        <input
                          ref={toldRef}
                          id="co-told"
                          type="checkbox"
                          aria-controls="co-booking"
                          className={`h-5 w-5 shrink-0 rounded-[var(--radius-xs)] border-border accent-[var(--accent)]${view.notice.told.ring ? ` ${styles.ring}` : ""}`}
                          checked={view.notice.told.checked}
                          disabled={view.notice.told.disabled}
                          onChange={(e) => dispatch({ type: "toldChanged", checked: e.target.checked })}
                          onBlur={() => dispatch({ type: "boxLeft" })}
                        />
                        <span className="text-sm font-semibold">{view.notice.told.label}</span>
                      </label>
                    )}
                  </WarningNotice>
                )}
              </section>

              {b && (
                <section
                  id="co-booking"
                  className={`${cardCls} ${styles.stack} ${styles.booking}`}
                >
                  <div>
                    <span id="co-day-label" className={labelCls}>
                      {COPY.newTime.dayLabel}
                    </span>
                    <div className="mt-1" role="group" aria-labelledby="co-day-label" aria-describedby="co-day-line">
                      <div className={styles.dayRow}>
                        {b.days.map((d) => (
                          <button
                            key={d.date}
                            type="button"
                            data-day={d.date}
                            aria-pressed={d.pressed}
                            aria-label={d.label}
                            disabled={d.disabled}
                            onClick={() => dispatch({ type: "dayChosen", date: d.date })}
                            className={`${DAY_CHIP} ${d.pressed ? DAY_CHIP_CHOSEN : DAY_CHIP_REST}`}
                          >
                            <span className={d.pressed ? "text-[11px] font-semibold" : "text-[11px] font-semibold text-fg-muted"}>{d.top}</span>
                            <span className="text-lg font-semibold leading-tight">{d.num}</span>
                            <span className={d.pressed ? "text-[11px]" : "text-[11px] text-fg-muted"}>{d.bottom}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <p
                    id="co-day-line"
                    role="status"
                    className={`text-sm ${b.line.tone === "fg" ? "text-fg" : b.line.tone === "error" ? "text-error" : "text-fg-muted"} ${proseCls}`}
                  >
                    {b.line.text}
                  </p>

                  <div>
                    <span id="co-time-label" className={labelCls}>
                      {COPY.newTime.timeLabel}
                    </span>
                    <div className="mt-1">
                      <div
                        role="group"
                        aria-labelledby="co-time-label"
                        aria-describedby="co-day-line"
                        aria-disabled={b.times.disabled ? true : undefined}
                        className={`rounded-[var(--radius-md)] border border-border px-4 py-3 ${styles.slotWell}`}
                      >
                        {[
                          { id: "co-slot-group-0", name: COPY.newTime.morning, slots: b.times.morning },
                          { id: "co-slot-group-1", name: COPY.newTime.afternoon, slots: b.times.afternoon },
                        ]
                          .filter((g) => g.slots.length > 0)
                          .map((g) => (
                            <div key={g.id} className={styles.slotGroup}>
                              <p id={g.id} className="text-sm font-semibold text-fg">
                                {g.name}
                              </p>
                              <div role="group" aria-labelledby={g.id} className={`${styles.slots} gap-2`}>
                                {g.slots.map((t) => (
                                  <button
                                    key={t.start}
                                    type="button"
                                    aria-pressed={t.pressed}
                                    disabled={b.times.disabled}
                                    onClick={() => dispatch({ type: "timeChosen", start: t.start })}
                                    className={`flex min-h-11 w-full items-center justify-center rounded-md border px-3 py-2.5 text-sm tabular-nums disabled:opacity-60 ${
                                      t.pressed ? "border-accent bg-pennie-sky-soft font-semibold text-fg dark:bg-accent/20" : "border-border bg-surface text-fg hover:border-fg/45"
                                    }`}
                                  >
                                    <MarkedLabel className="gap-2" mark={<span className="h-1.5 w-1.5 rounded-full bg-pennie-green" />}>
                                      {t.label}
                                    </MarkedLabel>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>

                  {b.reason && (
                    <div>
                      <label className={labelCls} htmlFor="co-reason">
                        {COPY.newTime.reasonLabel}
                      </label>
                      <SelectField
                        id="co-reason"
                        className="mt-1 w-64"
                        value={b.reason.value ?? ""}
                        placeholder={b.reason.placeholder}
                        options={b.reason.options}
                        disabled={b.reason.disabled}
                        onChange={(code) => dispatch({ type: "reasonChosen", code })}
                      />
                    </div>
                  )}

                  {b.detail && (
                    <div className={styles.detail}>
                      <label className={labelCls} htmlFor="co-detail">
                        {b.detail.label}
                      </label>
                      <textarea
                        id="co-detail"
                        rows={2}
                        maxLength={b.detail.max}
                        value={b.detail.value}
                        disabled={b.detail.disabled}
                        onChange={(e) => dispatch({ type: "detailEdited", value: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:border-[var(--sky)] focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-60"
                      />
                    </div>
                  )}

                  <div className={styles.confirm}>
                    <button
                      ref={confirmRef}
                      id="co-confirm"
                      type="button"
                      className={btnCls}
                      aria-haspopup="dialog"
                      disabled={b.confirm.refused || b.confirm.placing}
                      data-refused={b.confirm.refused || undefined}
                      aria-describedby={b.confirm.note ? "co-confirm-why" : b.confirm.failure ? "co-confirm-failed" : undefined}
                      onClick={() => dispatch({ type: "confirmPressed" })}
                    >
                      {b.confirm.label}
                    </button>
                    {b.confirm.note && (
                      <p id="co-confirm-why" className="mt-2 text-xs text-fg-muted">
                        {b.confirm.note}
                      </p>
                    )}
                    {b.confirm.failure && (
                      <p id="co-confirm-failed" role="alert" className={`mt-2 text-sm text-error ${proseCls}`}>
                        {b.confirm.failure}
                      </p>
                    )}
                  </div>

                  {b.catcher && (
                    // Over the whole locked card, so a press on any field or on the card's own
                    // padding lands here; reachable by Tab, so a key on it is an attempt too.
                    <button
                      id="co-catch"
                      type="button"
                      aria-label={b.catcher}
                      className={`${styles.catch} absolute inset-0 z-10 rounded-md cursor-not-allowed`}
                      onClick={() => dispatch({ type: "lockedAttempt" })}
                      onKeyDown={(e) => {
                        if (NAV_KEYS.has(e.key)) return;
                        e.preventDefault();
                        dispatch({ type: "lockedAttempt" });
                      }}
                    />
                  )}
                  {b.overlay && (
                    <button
                      id="co-overlay"
                      type="button"
                      onClick={pointToBox}
                      className={`${styles.overlay} absolute z-10 inline-flex items-center gap-2 rounded-md border border-border bg-surface-elevated px-4 py-3 text-sm font-semibold text-fg shadow-pop`}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4 shrink-0"
                      >
                        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                      </svg>
                      {b.overlay}
                    </button>
                  )}
                </section>
              )}

              <ModalDialog
                open={view.dialog !== null}
                onClose={() => dispatch({ type: "dialogClosed" })}
                labelledBy="co-dialog-title"
                describedBy="co-dialog-body"
                initialFocusRef={backRef}
                returnFocusRef={confirmRef}
              >
                {view.dialog && (
                  <>
                    <h2 id="co-dialog-title" className="text-lg font-semibold text-fg">
                      {view.dialog.title}
                    </h2>
                    <div id="co-dialog-body">
                      <p className={`mt-3 text-xl font-semibold text-fg ${proseCls}`}>{view.dialog.when}</p>
                      {view.dialog.moves && <p className={`mt-2 text-base text-fg ${proseCls}`}>{view.dialog.moves}</p>}
                    </div>
                    <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                      <button
                        ref={backRef}
                        id="co-dialog-back"
                        type="button"
                        className={btnSecondaryCls}
                        disabled={view.dialog.placing}
                        onClick={() => dispatch({ type: "dialogClosed" })}
                      >
                        {view.dialog.back}
                      </button>
                      <button
                        id="co-dialog-go"
                        type="button"
                        className={btnCls}
                        disabled={view.dialog.placing}
                        aria-busy={view.dialog.placing || undefined}
                        onClick={() => dispatch({ type: "placePressed", submissionId: mintSubmissionId(), at: Date.now() })}
                      >
                        {view.dialog.placing ? (
                          <SubmitPending elapsedMs={elapsedMs} pendingLabel={view.dialog.pending} slowLabel={COPY.more.slow} />
                        ) : (
                          view.dialog.go
                        )}
                      </button>
                    </div>
                  </>
                )}
              </ModalDialog>
            </>
          )}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {view.live}
      </div>
    </>
  );
}
