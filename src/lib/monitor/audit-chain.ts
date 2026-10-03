/**
 * Has anybody changed the audit log since it was written? (#3090)
 *
 * 0089 made `audit_log` refuse UPDATE, DELETE and TRUNCATE, which holds against
 * every caller except one that can switch the trigger off: a role with DDL rights
 * can disable it, edit a row, enable it again, and the table looks untouched.
 * Migration 0160 closes that by chaining the rows. Each row stores `chain_seq`
 * (1, 2, 3, ... with no gaps) and `chain_hash`, the SHA-256 of the previous row's
 * hash plus this row's content, computed by a trigger inside the database.
 *
 * This is the half that READS the chain. The hash is recomputed here, in the
 * Worker, rather than by calling a database function, because a role able to
 * replace the trigger can replace a verifying function just as easily and have it
 * agree with everything. The text that is hashed must match the migration's
 * `audit_log_chain_link` byte for byte; `pnpm verify:audit-chain-sql` proves that
 * against a real Postgres, and `scripts/test-audit-chain.ts` pins a vector that
 * command measured, so a drift on either side fails the build.
 *
 * HOW IT WALKS. A few hundred rows per monitor tick, from the start of the chain
 * to its end, then from the start again, for ever. Walking only forward would
 * check each row once, on the day it was written, and never notice an edit made
 * a month later, which is the edit this exists for. Its place is kept in
 * `audit_log_chain_verify`:
 *
 *   pass    how far the current walk from the start has got, and the hash there.
 *   anchor  the furthest row any complete walk has verified, and its hash then.
 *
 * The anchor is what catches the careful edit: somebody who rewrites a row AND
 * recomputes every hash after it leaves a chain that verifies, but the hash at the
 * anchor is no longer the one the last walk saw. And a chain that now ends before
 * the anchor has lost rows off its end.
 *
 * Four ways to break, each named for what the reader goes looking for (L11):
 *
 *   altered    a row's content no longer matches the hash stored with it.
 *   missing    a row is gone from the middle: the sequence skips.
 *   rewritten  the chain verifies, but its hash at the anchor has changed.
 *   truncated  the chain ends before the anchor.
 *
 * A broken walk does not move: the next tick re-reads the same rows and pages
 * again (the cooldown paces it), so a row put back the way it was written lets the
 * walk carry on, and the next COMPLETE walk sends the all clear. The all clear
 * hangs off that complete, measured walk and nothing else; a tick that could not
 * read, or one part way through a walk, says nothing either way (#1134, #1152).
 *
 * COST. Three subrequests a tick on the budget four cron lanes share: read the
 * position, read up to `AUDIT_CHAIN_ROWS_PER_TICK` rows (one page, under the 1000
 * row cap), write the position. A broken tick skips the write. Hashing is a few
 * hundred SHA-256 digests of a few hundred bytes each.
 *
 * Its only runtime import is the alert failure logger, by a relative path, so the
 * verify command can still load it on bare node.
 */
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";

/** alert_state key for the page and its all clear. */
export const AUDIT_CHAIN_KEY = "audit_log_chain_broken";

/** The hash the first row is chained onto, as 0160 writes it. */
export const AUDIT_CHAIN_GENESIS = "0".repeat(64);

/**
 * Rows read per tick. Under PostgREST's 1000 row page, and small enough that the
 * digests cost nothing; at this rate a trail of 100,000 rows is re-walked in
 * about a day of five minute ticks.
 */
export const AUDIT_CHAIN_ROWS_PER_TICK = 500;

/**
 * One `audit_log` row as the lane reads it. `details` is the jsonb column cast to
 * TEXT by the read (`details::text`), because the hash is over Postgres's own
 * rendering of it and a parsed object cannot be turned back into that. `created_at`
 * is the timestamp exactly as PostgREST renders it.
 */
export interface AuditChainRow {
  id: string;
  org_id: string;
  actor_id: string | null;
  action: string;
  target_id: string | null;
  details: string;
  created_at: string;
  chain_seq: number;
  chain_hash: string;
}

/** The verifier's place, as `audit_log_chain_verify` stores it. */
export interface AuditChainPosition {
  passSeq: number;
  passHash: string;
  anchorSeq: number;
  anchorHash: string;
}

/** Where a verifier with no stored row starts: the beginning, with nothing anchored. */
export const AUDIT_CHAIN_START: AuditChainPosition = {
  passSeq: 0,
  passHash: AUDIT_CHAIN_GENESIS,
  anchorSeq: 0,
  anchorHash: AUDIT_CHAIN_GENESIS,
};

// ------------------------------------------------------------ the hash

const encoder = new TextEncoder();

/** One field: its UTF-8 byte length, a colon and the value, or a tilde for a null. */
export function chainField(value: string | null): string {
  return value === null ? "~" : `${encoder.encode(value).length}:${value}`;
}

const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?(?::\d{2})?)$/;

/**
 * A timestamp as PostgREST renders it, as integer microseconds since the epoch,
 * which is how 0160 hashes `created_at`. Done on the string rather than through
 * `Date`, which keeps milliseconds and would lose the last three digits Postgres
 * stores. Null for anything that is not a timestamp with an offset.
 */
export function epochMicros(stamp: string): string | null {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const seconds = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
  if (!Number.isFinite(seconds)) return null;
  let offset = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const parts = zone.slice(1).replace(/^(\d{2})(\d{2})/, "$1:$2").split(":").map(Number);
    offset = sign * ((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0));
  }
  const micros = BigInt(seconds - offset) * BigInt(1_000_000) + BigInt((frac ?? "").padEnd(6, "0") || "0");
  return micros.toString();
}

/** The exact text 0160's `audit_log_chain_link` hashes, or null when a field is unreadable. */
export function chainContent(prevHash: string, row: AuditChainRow): string | null {
  const micros = epochMicros(row.created_at);
  if (micros === null) return null;
  return (
    prevHash +
    chainField(String(row.chain_seq)) +
    chainField(row.id) +
    chainField(row.org_id) +
    chainField(row.actor_id) +
    chainField(row.action) +
    chainField(row.target_id) +
    chainField(row.details) +
    chainField(micros)
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash this row should carry after `prevHash`, or null when it cannot be computed. */
export async function chainLink(prevHash: string, row: AuditChainRow): Promise<string | null> {
  const content = chainContent(prevHash, row);
  return content === null ? null : sha256Hex(content);
}

// ------------------------------------------------------------ the walk

export type AuditChainBreak =
  | { kind: "altered"; seq: number; id: string }
  | { kind: "missing"; expectedSeq: number; foundSeq: number; id: string }
  | { kind: "rewritten"; seq: number; id: string }
  | { kind: "truncated"; anchorSeq: number; lastSeq: number };

export type AuditChainWalk =
  /** A row this cannot hash, so nothing about it or after it was measured. */
  | { status: "unreadable"; why: string }
  | { status: "broken"; break: AuditChainBreak; checked: number }
  /** Part way through a walk, every row read so far intact. */
  | { status: "progressing"; checked: number; next: AuditChainPosition }
  /** A walk from the start reached the end of the chain with nothing wrong. */
  | { status: "intact"; checked: number; throughSeq: number; next: AuditChainPosition };

/**
 * Judge one tick's rows. Pure apart from the digest, so every branch is driven
 * offline. `rows` must be the rows after `position.passSeq`, ascending by
 * `chain_seq`, at most `limit` of them; fewer than `limit` means the read reached
 * the end of the chain.
 */
export async function walkAuditChain(
  position: AuditChainPosition,
  rows: AuditChainRow[],
  limit: number,
): Promise<AuditChainWalk> {
  let seq = position.passSeq;
  let hash = position.passHash;
  let checked = 0;
  for (const row of rows) {
    if (row.chain_seq !== seq + 1) {
      return { status: "broken", break: { kind: "missing", expectedSeq: seq + 1, foundSeq: row.chain_seq, id: row.id }, checked };
    }
    const expected = await chainLink(hash, row);
    if (expected === null) {
      return { status: "unreadable", why: `audit_log row ${row.chain_seq} has a created_at this cannot read` };
    }
    if (expected !== row.chain_hash) {
      return { status: "broken", break: { kind: "altered", seq: row.chain_seq, id: row.id }, checked };
    }
    if (row.chain_seq === position.anchorSeq && row.chain_hash !== position.anchorHash) {
      return { status: "broken", break: { kind: "rewritten", seq: row.chain_seq, id: row.id }, checked };
    }
    seq = row.chain_seq;
    hash = row.chain_hash;
    checked++;
  }

  if (rows.length >= limit) {
    return { status: "progressing", checked, next: { ...position, passSeq: seq, passHash: hash } };
  }

  // The end of the chain. It must reach at least as far as the last complete walk
  // did; the anchor row itself was checked above if this walk passed it.
  if (seq < position.anchorSeq) {
    return { status: "broken", break: { kind: "truncated", anchorSeq: position.anchorSeq, lastSeq: seq }, checked };
  }
  return {
    status: "intact",
    checked,
    throughSeq: seq,
    next: { passSeq: 0, passHash: AUDIT_CHAIN_GENESIS, anchorSeq: seq, anchorHash: hash },
  };
}

// ------------------------------------------------------------ the copy

function reason(b: AuditChainBreak): string {
  switch (b.kind) {
    case "altered":
      return `entry ${b.seq} (audit_log id ${b.id}) no longer matches the hash stored when it was written, so its contents were changed`;
    case "missing":
      return `entry ${b.expectedSeq} is gone: the chain goes from ${b.expectedSeq - 1} straight to ${b.foundSeq} (audit_log id ${b.id}), so a row was deleted`;
    case "rewritten":
      return `the hash at entry ${b.seq} (audit_log id ${b.id}) is not the one the last full check saw, so an earlier row was changed and every hash after it recomputed`;
    case "truncated":
      return `the chain now ends at entry ${b.lastSeq}, and entry ${b.anchorSeq} was there at the last full check, so rows were deleted from the end`;
  }
}

/**
 * The page. A broken chain means something able to switch off the append only
 * guard has used it, so the copy treats it as a security incident and tells the
 * reader what NOT to do first: repairing the row destroys the evidence.
 */
export function formatAuditChainBrokenAlert(b: AuditChainBreak): string {
  return (
    `The audit log has been changed after it was written: ${reason(b)}. Only a role able to ` +
    `switch off its append only guard can do this, so treat it as a security incident. Do not ` +
    `repair the row. Keep a copy of audit_log as it is now, then look for who disabled or dropped ` +
    `the audit_log triggers. This repeats until the chain verifies from start to end.`
  );
}

/** The all clear, hung off a complete walk that found nothing wrong. */
export function formatAuditChainRecovery(throughSeq: number): string {
  return (
    `The audit log verifies again: every entry from the first to entry ${throughSeq} matches ` +
    `the hash stored when it was written. No action is needed.`
  );
}

// ------------------------------------------------------------ the runner

export type AuditChainResult =
  /** Not measured, so nothing may be claimed in either direction. */
  | { status: "unmeasured"; why: string }
  | { status: "broken"; break: AuditChainBreak; checked: number }
  | { status: "progressing"; checked: number; passSeq: number }
  | { status: "intact"; checked: number; throughSeq: number };

export interface AuditChainDeps {
  /** The stored position, or null when the verifier has never run. THROWS on a read error. */
  loadPosition: () => Promise<AuditChainPosition | null>;
  /** Up to `limit` rows after `afterSeq`, ascending by chain_seq. THROWS on a read error. */
  loadRows: (afterSeq: number, limit: number) => Promise<AuditChainRow[]>;
  /** Store the position. THROWS on a write error. */
  savePosition: (position: AuditChainPosition) => Promise<void>;
  notify: ThrottledNotify<unknown>;
  /** REQUIRED, so a condition cannot be wired with no way to end it (#1151). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  limit?: number;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Read, walk, page or clear. A read or write that threw measured nothing, so it
 * pages nothing and clears nothing; a notify or resolve failure is logged and
 * does not throw, because a flaky Slack must never fail the tick.
 */
export async function runAuditChainCheck(deps: AuditChainDeps): Promise<AuditChainResult> {
  const limit = deps.limit ?? AUDIT_CHAIN_ROWS_PER_TICK;
  let walk: AuditChainWalk;
  try {
    const position = (await deps.loadPosition()) ?? AUDIT_CHAIN_START;
    const rows = await deps.loadRows(position.passSeq, limit);
    walk = await walkAuditChain(position, rows, limit);
    if (walk.status === "progressing" || walk.status === "intact") await deps.savePosition(walk.next);
  } catch (err) {
    return { status: "unmeasured", why: message(err) };
  }

  switch (walk.status) {
    case "unreadable":
      return { status: "unmeasured", why: walk.why };
    case "broken":
      await deps.notify(AUDIT_CHAIN_KEY, deps.cooldownMs, formatAuditChainBrokenAlert(walk.break)).catch(logAlertSendFailure(AUDIT_CHAIN_KEY));
      return { status: "broken", break: walk.break, checked: walk.checked };
    case "progressing":
      return { status: "progressing", checked: walk.checked, passSeq: walk.next.passSeq };
    case "intact":
      await deps.resolve(AUDIT_CHAIN_KEY, formatAuditChainRecovery(walk.throughSeq)).catch(logResolveFailure(AUDIT_CHAIN_KEY));
      return { status: "intact", checked: walk.checked, throughSeq: walk.throughSeq };
  }
}
