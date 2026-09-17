// Static detector for the #2379 guard: a Supabase WRITE in a server action whose
// result is thrown away. See scripts/test-unchecked-writes.ts for the fixtures
// and the positive controls that prove this actually catches the bad pattern.
//
// THE BUG CLASS. supabase-js does NOT throw on a statement Postgres refuses. It
// resolves `{ error }`, so this:
//
//   await db.from("booking_settings").upsert({ id: 1, public_booking_paused: true }, ...);
//   await recordAudit({ action: "booking.settings", details: { public_booking_paused: true } });
//   revalidatePath("/admin/business-hours");
//   redirect(`/admin/business-hours?ok=booking-paused`);
//
// runs to completion whether the row was written or not. On a refusal (a half
// applied migration, an RLS or grant change, a statement timeout, a transient
// 5xx) the admin is shown "Online booking is stopped", the audit trail records
// `public_booking_paused: true`, and the embed keeps taking bookings. The record
// written to answer "were we taking bookings at 3am" answers it with a confident
// wrong value, which is the one question it exists for (L529, L12).
//
// Eleven writes in src/app/admin/actions.ts were written that way, including the
// kill switch and the role change, and nothing could see them: the sibling read
// guard (scan-swallowed-error-reads.ts) skips a chain whose mutator is reached
// before its `.select(`, and recorded in its own header that a write is "a
// different concern". True, and with nothing on the far side of that boundary it
// read as a class somebody had handled (L400).
//
// A WRITE SITE is an awaited Supabase chain, carrying one of `.insert(`,
// `.update(`, `.upsert(` or `.delete(`, that appears as an EXPRESSION STATEMENT:
//
//   await db.from("users").update({ role: next }).eq("id", userId);
//   await supabaseAdmin().from("monitor_settings").upsert(rows, { onConflict: "key" });
//
// The result of an expression statement has nowhere to go, so nothing anywhere
// can consult its `error`. That is the whole test, and it is why this can be a
// text scan at all: it asks where the value WENT, not what was done with it.
//
// It is NOT flagged when the result is taken somewhere a caller could read it:
//
//   const { error } = await db.from("buckets").update(after).eq("id", id);  // bound
//   const res = await db.from("users").update(...);                        // named
//   return db.from("t").delete().eq("id", id);                             // handed on
//   return await db.from("t").delete().eq("id", id);                       // handed on
//
// nor when the chain is not a Supabase one (no `.from(`), nor when it carries no
// mutator at all (that is a read, and the sibling guard owns it), nor when it
// carries the `// write-ok:` opt-out below.
//
// SCOPE, stated so a green run is never read as more coverage than it has. This
// sees the DISCARDED result and nothing else. A result that is bound to a name
// and then never consulted:
//
//   const res = await db.from("users").update({ role: next }).eq("id", userId);
//   // ... and res.error read nowhere
//
// is the same defect and is NOT flagged here. It is the result-object shape the
// sibling read scanner already covers for reads, and it has not appeared once on
// this surface: every instance found by #2379 was a bare `await`. Widening to it
// means asking whether `.error` is read anywhere in the file, which is the read
// scanner's `scanResultObjectReads` and the place to extend if one turns up.
// A write inside a `Promise.all([...])` whose combined result is discarded is
// still flagged, because the chain's own result goes nowhere either. But a write
// whose result is BOUND INSIDE that wrapper is not (#2482):
//
//   await Promise.all(rows.map(async (r) => {
//     const { data, error } = await db.from("t").insert(r).select("id").single();
//     if (error) throw error;                     // <- this write is checked
//   }));
//
// The outer statement discards an array of voids; the write itself was consulted.
// Flagging it would demand a `// write-ok:` on code that already does the right
// thing, and a guard that asks for an annotation saying a checked write is
// tolerable is teaching the opposite of what it exists for (L36).
//
// THE ESCAPE HATCH is `// write-ok: <why>` on, or in the `//` block directly
// above, the awaited statement:
//
//   // write-ok: a best effort touch; the next tick rewrites the row from scratch
//   await db.from("sync_locks").update({ touched_at: now }).eq("key", k);
//
// It is deliberately NOT the siblings' `// error-ok:`. Putting a second rule
// behind an existing suppression token silently widens every existing use of it
// (L448), and an `// error-ok:` is written about a READ: it would then exempt a
// write sitting under the same comment block, which is exactly the pairing that
// occurs in an action that reads a row and then writes it.
//
// Use it only when nothing downstream reads the write as having happened: no
// audit entry claiming the value, no success notice, no cache invalidation
// standing in for the change. The question is the sibling guard's question in
// the other direction: not "can this write fail harmlessly" but "does anything
// after it tell somebody it succeeded?"
//
// Like its siblings this is a deliberate text scan, not a parser: lightweight,
// dependency free, and honest about the one shape it does not see.

import { lineOf, maskLiterals, hasCommentOptOut } from "./scan-swallowed-error-reads.ts";

export interface UncheckedWriteFinding {
  file: string;
  line: number;
  /** The mutator that makes it a write: `insert`, `update`, `upsert` or `delete`. */
  mutator: string;
  /** The table it writes, when the `.from("...")` names one literally. */
  table: string | null;
  /** The statement (whitespace collapsed, truncated for readability). */
  snippet: string;
}

const MUTATORS = ["insert", "update", "upsert", "delete"] as const;

/** The opt-out token. Its own word, never the siblings' `error-ok` (L448). */
export const WRITE_OPT_OUT = "write-ok";

/**
 * True when the `await` at `index` BEGINS a statement, so its value is discarded.
 *
 * Stated positively (the previous non-whitespace character is `;`, `{`, `}`, or
 * the start of the file) rather than as a list of the characters that would mean
 * the value goes somewhere. An exclusion list admits every form nobody thought of
 * (L257), and here that failure is silent in the wrong direction: a shape it does
 * not recognise is simply never flagged.
 *
 * The cost of the positive rule is a brace-less `if (x) await db...;`, whose
 * `await` follows a `)`. That is not flagged, and it is not a shape that appears
 * on this surface: every write in the scanned tree is a statement in a block.
 */
/**
 * The `await` whose value actually carries the chain at `fromIndex` (#2482).
 *
 * The outermost `await` of a statement is not always the one the write's result
 * flows to: `await Promise.all(rows.map(async () => { const { error } = await
 * db.from(...)... }))` has two, and only the INNER one is about the write. Asking
 * the outer one whether it discards its value answers a question about the array
 * of voids rather than about the write.
 *
 * Returns the index of the nearest `await` before the chain, or -1 when there is
 * none inside the statement.
 */
function awaitCarrying(masked: string, statementStart: number, fromIndex: number): number {
  let best = -1;
  for (const m of masked.slice(statementStart, fromIndex).matchAll(/\bawait\b/g)) {
    best = statementStart + (m.index as number);
  }
  return best;
}

/**
 * True when the value of the `await` at `index` goes nowhere.
 *
 * `beginsStatement` answers it for the outermost await. This answers it for an
 * inner one too: a value assigned (`const { error } = await ...`), returned, or
 * passed as an argument has somewhere to be consulted, so only a bare statement
 * position discards it.
 */
function discardsValue(masked: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const c = masked[i];
    if (/\s/.test(c)) continue;
    return c === ";" || c === "{" || c === "}";
  }
  return true;
}

function beginsStatement(masked: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const c = masked[i];
    if (/\s/.test(c)) continue;
    return c === ";" || c === "{" || c === "}";
  }
  return true; // nothing before it at all
}

/**
 * The statement's text: from `start` to the `;` that closes it at bracket depth
 * zero. Depth aware because a write's argument routinely carries a callback
 * (`rows.map((r) => { ... })`) whose body can hold a `;` of its own, and stopping
 * there would cut the chain in half and lose the mutator.
 */
function statementText(masked: string, start: number): { text: string; end: number } {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return { text: masked.slice(start, i), end: i };
  }
  return { text: masked.slice(start), end: masked.length };
}

/**
 * The chain text for an expression whose lead is a NAME rather than a `.from(` of
 * its own (`q.eq("id", id)` where `let q = db.from("t").update(...)` sits on an
 * earlier line). The lead's nearest preceding definition is prepended, so the
 * `.from(` and the mutator that decide this is a write are still reachable.
 *
 * Mirrors `resolveLeadChain` in the sibling scanner rather than importing it,
 * because that one is what #1641's controls rest on and loosening its rule would
 * re-open a decision that is already pinned.
 */
function resolveLead(masked: string, text: string, beforeIndex: number): string {
  if (text.includes(".from(")) return text;
  const lead = /^\s*([A-Za-z_$][\w$]*)\s*(?:\(|\.|$)/.exec(text);
  if (!lead) return text;
  const defRe = new RegExp(`(?:const|let|var)\\s+${lead[1]}\\s*=`, "g");
  let defIndex = -1;
  for (const dm of masked.slice(0, beforeIndex).matchAll(defRe)) defIndex = dm.index as number;
  if (defIndex === -1) return text;
  const defEnd = masked.indexOf(";", defIndex);
  const def = masked.slice(defIndex, defEnd === -1 ? beforeIndex : defEnd);

  // A local FUNCTION is not a query builder (#2482). `const run = async () => { ...
  // writes ... }` followed by `await run()` would otherwise inherit every write in
  // the body and be judged as though the statement were the chain, even when each
  // write inside binds and checks its own error. The builder case this exists for
  // (`let q = db.from("t").update(...)` then `await q.eq(...)`) never carries a
  // function head, so the two are told apart by the head rather than by the body.
  if (/=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(def)) return text;

  return `${def};${text}`;
}

/** The first mutator called on the chain, or null when it is a read. */
function mutatorOf(chain: string): string | null {
  let best: { name: string; at: number } | null = null;
  for (const m of MUTATORS) {
    const at = chain.indexOf(`.${m}(`);
    if (at === -1) continue;
    if (!best || at < best.at) best = { name: m, at };
  }
  return best ? best.name : null;
}

/**
 * The table named by the chain's `.from("...")`, read off the ORIGINAL source so
 * the finding can name it: the masked copy has the string's content blanked. Null
 * when the table is a variable, which is legitimate and simply unnameable here.
 */
function tableOf(original: string): string | null {
  const m = /\.from\(\s*["'`]([^"'`]+)["'`]/.exec(original);
  return m ? m[1] : null;
}

/** A whitespace-collapsed, comment-stripped, length-capped quote of a statement. */
function snippetOf(source: string, start: number, end: number): string {
  const shown = source
    .slice(start, end)
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return shown.length > 120 ? `${shown.slice(0, 117)}...` : shown;
}

export function scanUncheckedWrites(source: string, file = "<source>"): UncheckedWriteFinding[] {
  const findings: UncheckedWriteFinding[] = [];
  const masked = maskLiterals(source);

  for (const m of masked.matchAll(/\bawait\b/g)) {
    const awaitIndex = m.index as number;
    if (!beginsStatement(masked, awaitIndex)) continue;

    const exprStart = awaitIndex + m[0].length;
    const { text, end } = statementText(masked, exprStart);
    const chain = resolveLead(masked, text, awaitIndex);
    if (!chain.includes(".from(")) continue; // not a Supabase chain
    const mutator = mutatorOf(chain);
    if (!mutator) continue; // a read; the sibling guard owns those
    if (hasCommentOptOut(source, awaitIndex, WRITE_OPT_OUT)) continue;

    // The chain may sit INSIDE this statement rather than being it (#2482). Judge
    // the await nearest the chain: when that one binds its value, the write was
    // consulted and this statement's discarded array says nothing about it.
    const fromAt = masked.indexOf(".from(", exprStart);
    if (fromAt !== -1 && fromAt < end) {
      const carrying = awaitCarrying(masked, exprStart, fromAt);
      if (carrying !== -1 && !discardsValue(masked, carrying)) continue;
    }

    findings.push({
      file,
      line: lineOf(source, awaitIndex),
      mutator,
      table: tableOf(source.slice(awaitIndex, end)),
      snippet: snippetOf(source, awaitIndex, end),
    });
  }

  return findings.sort((a, b) => a.line - b.line);
}
