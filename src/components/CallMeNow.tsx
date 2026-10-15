"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { BookerButton } from "@/components/BookerButton";
import type { BookerButtonPalette } from "@/components/booker-button";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { CALL_ME_NOW_COPY } from "@/lib/booking/booker-copy";

/**
 * The inline card's Call me now row (#3718), as settled in design rounds 1 to 3
 * (docs/design/inline-booker.html): the row above or below the times, the card's
 * confirmation after a press, and the notice when a press did not go through.
 *
 * It talks only to `/api/call-me-now`, and sends only what the host page passed
 * (`CallMeNowConfig`), never details Slate looked up: the route checks them against
 * the Lead, and Salesforce's own values would always match.
 *
 * Fails toward booking a time: a check that fails or is refused hides the row, and
 * a press that does not go through says so and leaves the times on screen.
 */

/** The row as `/book` hands it over. */
export interface CallMeNowConfig {
  position: "above" | "below";
  leadId: string;
  email: string | null;
  phone: string | null;
  submissionId: string | null;
  firstName: string | null;
  /**
   * The demo link's row (`/demo?layout=inline`): offered at once, and a press goes
   * straight to the confirmation with this texting number. Nothing is fetched, so a
   * press on the demo reaches no Salesforce lead and no advisor.
   */
  demo?: { textLine: string };
}

export type CallMeNowPhase =
  | "hidden"
  | "checking"
  | "offered"
  | "pressing"
  | "failed"
  | "refused"
  | "confirmed"
  | "dismissed";

/**
 * How long a check or a press may run before it is given up, past the route's own
 * worst case: a check then hides the row, a press fails with Try again.
 */
const GIVE_UP_MS = 20_000;

function post(config: CallMeNowConfig, action: "check" | "request", signal?: AbortSignal) {
  return fetch("/api/call-me-now", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      leadId: config.leadId,
      email: config.email,
      phone: config.phone,
      submissionId: config.submissionId,
    }),
    signal,
  });
}

/** The row's state: whether it shows, and what a press came to. */
export function useCallMeNow(config: CallMeNowConfig | null, opts: { autoPress?: boolean } = {}) {
  // #3718: the pop up a Call me now piece opens presses on arrival: the piece already
  // asked whether the row is offered, and the route asks again on the press.
  const autoPress = !!(config && opts.autoPress);
  const [phase, setPhase] = useState<CallMeNowPhase>(
    config ? (autoPress ? "pressing" : config.demo ? "offered" : "checking") : "hidden",
  );
  const [textLine, setTextLine] = useState<string | null>(null);

  useEffect(() => {
    if (!config || config.demo || autoPress) return;
    let live = true;
    const abort = new AbortController();
    const giveUp = setTimeout(() => abort.abort(), GIVE_UP_MS);
    post(config, "check", abort.signal)
      .then(async (res) => {
        const body = (await res.json()) as { offered?: unknown };
        if (live) setPhase(res.ok && body.offered === true ? "offered" : "hidden");
      })
      .catch(() => {
        if (live) setPhase("hidden");
      })
      .finally(() => clearTimeout(giveUp));
    return () => {
      live = false;
      clearTimeout(giveUp);
    };
    // The check is about this lead; the rest of the config cannot change while mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.leadId]);

  const press = useCallback(async () => {
    if (!config) return;
    if (config.demo) {
      setTextLine(config.demo.textLine);
      setPhase("confirmed");
      return;
    }
    setPhase("pressing");
    const abort = new AbortController();
    const giveUp = setTimeout(() => abort.abort(), GIVE_UP_MS);
    try {
      const res = await post(config, "request", abort.signal);
      const body = (await res.json().catch(() => ({}))) as { outcome?: unknown; textLine?: unknown };
      if (res.ok && (body.outcome === "requested" || body.outcome === "already-requested")) {
        setTextLine(typeof body.textLine === "string" ? body.textLine : null);
        setPhase("confirmed");
      } else if (body.outcome === "refused") {
        // Only the route's own refusal is final. A 429 (too many presses from this
        // address) clears once its window passes, so it is a failure with Try again.
        setPhase("refused");
      } else {
        setPhase("failed");
      }
    } catch {
      setPhase("failed");
    } finally {
      clearTimeout(giveUp);
    }
  }, [config]);

  // Once per mount: a press that failed offers Try again rather than pressing again.
  const pressed = useRef(false);
  useEffect(() => {
    if (!autoPress || pressed.current) return;
    pressed.current = true;
    void press();
  }, [autoPress, press]);

  const backToTimes = useCallback(() => setPhase("dismissed"), []);

  return { phase, textLine, press, backToTimes };
}

/** The row, or the notice a press left behind. Draws nothing in the other phases. */
export function CallMeNowRow({
  phase,
  position,
  onPress,
  palette,
  titleClass,
  mutedClass,
  confirmStyle,
}: {
  phase: CallMeNowPhase;
  /** Which side of the times the row sits, so the notice points at them correctly. */
  position: "above" | "below";
  onPress: () => void;
  palette: BookerButtonPalette;
  titleClass: string;
  mutedClass: string;
  confirmStyle?: CSSProperties;
}) {
  if (phase === "offered" || phase === "pressing") {
    const pressing = phase === "pressing";
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-surface p-[18px]">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${titleClass}`}>{CALL_ME_NOW_COPY.ready}</p>
          <p className={`mt-0.5 text-[13px] ${mutedClass}`}>{CALL_ME_NOW_COPY.haveCall}</p>
        </div>
        <BookerButton
          palette={palette}
          variant="primary"
          onClick={onPress}
          disabled={pressing}
          busy={pressing}
          style={confirmStyle}
          className="shrink-0"
        >
          {pressing ? CALL_ME_NOW_COPY.pressing : CALL_ME_NOW_COPY.button}
        </BookerButton>
      </div>
    );
  }
  if (phase === "failed" || phase === "refused") {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-2xl bg-surface p-[18px]">
        <span className="shrink-0 text-[var(--error)]">
          <AlertIcon width={22} height={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${titleClass}`}>{CALL_ME_NOW_COPY.failedHeading}</p>
          <p className={`mt-0.5 text-[13px] ${mutedClass}`}>{CALL_ME_NOW_COPY.failedBody(position)}</p>
        </div>
        {/* A refusal cannot be changed by retrying (L111), so only a failure offers it. */}
        {phase === "failed" && (
          <BookerButton palette={palette} variant="secondary" onClick={onPress} className="shrink-0">
            {CALL_ME_NOW_COPY.tryAgain}
          </BookerButton>
        )}
      </div>
    );
  }
  return null;
}

/** The card after a press went through: trypennie's own confirmation. */
export function CallMeNowConfirmation({
  firstName,
  textLine,
  onBackToTimes,
  onCardStyle,
  palette,
  titleClass,
  mutedClass,
}: {
  firstName: string | null;
  textLine: string | null;
  onBackToTimes: () => void;
  /** The text colour for the line sitting on the card itself, when a host set the card's colour. */
  onCardStyle?: CSSProperties;
  palette: BookerButtonPalette;
  titleClass: string;
  mutedClass: string;
}) {
  return (
    <>
      <div className="rounded-2xl bg-surface p-[18px]">
        <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-fg text-surface">
          <CheckIcon width={18} height={18} />
        </span>
        <p role="status" className={`text-lg font-semibold leading-snug ${titleClass}`}>
          <span className="block">{CALL_ME_NOW_COPY.thanks(firstName)}</span>
          <span className="block">{CALL_ME_NOW_COPY.momentarily}</span>
        </p>
        <p className={`mt-3.5 mb-3 text-sm ${titleClass}`}>{CALL_ME_NOW_COPY.expect}</p>
        <ol className="mb-3.5 grid gap-3">
          {CALL_ME_NOW_COPY.steps.map((step, i) => (
            <li key={step.title} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-current text-xs font-semibold tabular-nums ${titleClass}`}
              >
                {i + 1}
              </span>
              <div>
                <p className={`text-sm font-semibold ${titleClass}`}>{step.title}</p>
                <p className={`mt-0.5 text-[13px] ${mutedClass}`}>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        {/* Only with a real line to text: the service may be unset or silent, and
            then the card offers nothing rather than a dead link (Dan, 2026-10-14). */}
        {textLine && (
          <div className="flex items-center gap-3 rounded-xl border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold ${titleClass}`}>{CALL_ME_NOW_COPY.textHeading}</p>
              <p className={`mt-0.5 text-[13px] ${mutedClass}`}>{CALL_ME_NOW_COPY.textBody}</p>
            </div>
            <a
              href={`sms:${textLine}?&body=${encodeURIComponent(CALL_ME_NOW_COPY.textMessage)}`}
              className={`inline-flex min-h-11 shrink-0 items-center rounded-2xl border px-4 text-sm font-semibold ${palette.toggleBorder} ${palette.body} ${palette.navHover}`}
            >
              {CALL_ME_NOW_COPY.textButton}
            </a>
          </div>
        )}
      </div>
      <p className={`mt-3.5 text-center text-sm ${titleClass}`} style={onCardStyle}>
        {CALL_ME_NOW_COPY.instead}{" "}
        <button
          type="button"
          onClick={onBackToTimes}
          className="min-h-11 font-semibold underline underline-offset-[3px]"
        >
          {CALL_ME_NOW_COPY.insteadLink}
        </button>
      </p>
    </>
  );
}
