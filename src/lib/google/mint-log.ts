/**
 * One log line per delegated token mint (#3298).
 *
 * `DELEGATED_TOKEN_TIMEOUT_MS` was borrowed from the lead facing call budget, not
 * measured against Google's token endpoint, and two mints have run out of it
 * (2026-10-05 on the reminder lane, 2026-10-13 on the confirm path) with nothing
 * recorded to say how long an ordinary mint takes. So every mint that actually
 * goes to Google writes one line on settling. Six days of them were read on
 * 2026-10-20 and a full seven on 2026-10-22 (#3980), and both kept every deadline
 * as it was (the reading is on `DELEGATED_TOKEN_TIMEOUT_MS`); the lines stay, so
 * the next change to a deadline is sized from a fresh reading rather than that one.
 *
 * Only a real mint writes. A cache hit never reaches Google, so it measures
 * nothing about the token endpoint, and it is most of the calls: a token is good
 * for most of an hour, while the confirm path makes two or three Google calls per
 * booking and the sync lanes make one per agent per minute. A line per hit would
 * multiply the volume on the hot path for no reading. Joiners of a shared mint
 * (#3123) write nothing either, since the mint they waited on wrote its own line;
 * a joiner that mints again under its own deadline is a real mint and writes one.
 *
 * The line names no address and no token: the mint's own error message carries
 * the impersonated address, so only its status and parsed reason are kept.
 *
 *   slate tag=google-token-mint msg="token mint" scope="calendar" outcome="ok"
 *     duration_ms=412 deadline_ms=8000 limit_ms=8000 request="the booking confirm"
 */
import { findDeadlineExceeded, type Deadline } from "@/lib/fetch-within-deadline";
import { GoogleHttpError } from "@/lib/google/http-error";
import { log } from "@/lib/log";

const AUTH_PREFIX = "https://www.googleapis.com/auth/";

export type MintOutcome = "ok" | "timeout" | "error";

/** What one mint was for and what it was allowed, known before it starts. */
export interface MintContext {
  /** The OAuth scope string the token is minted for. */
  scope: string;
  /** The mint's own deadline: the Google call's, or the default for the Gmail and photo lanes. */
  deadlineMs: Deadline;
  /** What it actually had: its own deadline, or less when an enclosing budget had less left. */
  limitMs: Deadline;
  /**
   * The request it was made for (`requestLabel`): "the booking confirm" on a lead's confirm,
   * the calendar call's own `google <call>` label on the cron lanes, absent outside any budget
   * (Gmail sends, the photo lane, an after response refresh).
   */
  request?: string;
  /**
   * Why the shared token holder (#3512) did not answer instead, so a week of lines says
   * how often a mint was still needed and for which reason: `miss`, `expired`, `timeout`,
   * `error` or `unbound` from the read itself; `refused` when Google refused the token
   * the caller held (#3144), which skips the holder; `not-held` for a scope the holder
   * does not keep; `no-budget` when the enclosing budget was spent before it could ask;
   * `refresh` and `nudge` for a mint made AFTER a response to refresh an ageing token.
   */
  holder?: string;
}

/** The fields of the line, in the order they are written. */
export interface MintLine {
  scope: string;
  outcome: MintOutcome;
  duration_ms: number;
  deadline_ms?: number;
  limit_ms?: number;
  request?: string;
  /** Why the shared holder did not answer instead (#3512). */
  holder?: string;
  /** Set on a timeout an enclosing budget cut short, rather than the mint's own deadline. */
  cut_by_budget?: true;
  status?: number;
  reason?: string;
}

/**
 * The short name of a scope string: the part after Google's auth prefix, or for
 * several scopes sharing one API (the calendar trio) that API's name.
 */
export function mintScopeName(scope: string): string {
  const names = scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => (s.startsWith(AUTH_PREFIX) ? s.slice(AUTH_PREFIX.length) : s));
  if (names.length === 1) return names[0];
  const apis = new Set(names.map((n) => n.split(".")[0]));
  return apis.size === 1 ? [...apis][0] : names.join("+");
}

function finite(d: Deadline): number | undefined {
  return typeof d === "number" && Number.isFinite(d) ? d : undefined;
}

function lineFor(ctx: MintContext, durationMs: number, err: unknown, failed: boolean): MintLine {
  const line: MintLine = { scope: mintScopeName(ctx.scope), outcome: "ok", duration_ms: durationMs };
  const deadline = finite(ctx.deadlineMs);
  const limit = finite(ctx.limitMs);
  if (deadline !== undefined) line.deadline_ms = deadline;
  if (limit !== undefined) line.limit_ms = limit;
  if (ctx.request !== undefined) line.request = ctx.request;
  if (ctx.holder !== undefined) line.holder = ctx.holder;
  if (!failed) return line;
  const missed = findDeadlineExceeded(err);
  if (missed) {
    line.outcome = "timeout";
    if (missed.budget) line.cut_by_budget = true;
    return line;
  }
  line.outcome = "error";
  if (err instanceof GoogleHttpError) {
    line.status = err.status;
    if (err.reason) line.reason = err.reason;
  }
  return line;
}

/** The production writer: info for a mint that answered, warn for one that did not. */
export function writeMintLine(line: MintLine): void {
  const fields = { msg: "token mint", ...line };
  if (line.outcome === "ok") log.info("google-token-mint", fields);
  else log.warn("google-token-mint", fields);
}

/**
 * Run one mint and write its line when it settles, however it settles. The
 * result or the error is passed through unchanged.
 */
export async function timedMint<T>(
  work: () => Promise<T>,
  ctx: MintContext,
  now: () => number = () => Date.now(),
  write: (line: MintLine) => void = writeMintLine,
): Promise<T> {
  const startedAt = now();
  let value: T;
  try {
    value = await work();
  } catch (err) {
    write(lineFor(ctx, now() - startedAt, err, true));
    throw err;
  }
  // Outside the try, so the line is written once and a mint that answered is
  // never reported as failed by its own log line.
  write(lineFor(ctx, now() - startedAt, undefined, false));
  return value;
}

/**
 * Which tier answered a token request (#3512): the isolate's own cache, the shared
 * holder, or a mint. One line per answer from the holder or a mint, and per answer from
 * the isolate whenever a request label is in force (`requestLabel`). That is every
 * budgeted Google call, so the sync lanes' isolate hits are logged too (about 370,000 in
 * the week read for #3980); only a token read outside any budget (a Gmail send, the photo
 * lane) writes no isolate line. The share of confirms that still wait on a mint is the `request="the booking
 * confirm"` lines alone. `holder` says why a mint was needed, as on the mint line. Like
 * that line it names no address and no token.
 *
 *   slate tag=google-token-read msg="token read" tier="holder" scope="calendar" ms=14
 *     request="the booking confirm"
 */
export type TokenTier = "isolate" | "holder" | "mint";

export interface TokenReadLine {
  tier: TokenTier;
  scope: string;
  ms: number;
  holder?: string;
  request?: string;
}

export function writeTokenReadLine(line: TokenReadLine): void {
  const fields: Record<string, string | number> = { msg: "token read", tier: line.tier, scope: mintScopeName(line.scope), ms: line.ms };
  if (line.holder !== undefined) fields.holder = line.holder;
  if (line.request !== undefined) fields.request = line.request;
  log.info("google-token-read", fields);
}
