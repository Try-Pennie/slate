/**
 * The scan behind `scripts/test-save-outcomes.ts` (#1990).
 *
 * Separate from the guard so the decision logic can be driven by hand written
 * fixtures, including ones that must be CAUGHT, which a scan run only over the
 * real tree can never demonstrate: a scanner that reads nothing and a clean tree
 * produce the same empty result (L98).
 */

/** One server action, as the scan sees it. */
import { readOptOut, readOptOutOnLine } from "./opt-out.ts";

export interface ScannedAction {
  name: string;
  /** Does it change anything? */
  writes: boolean;
  /** Does it tell the caller what happened? */
  reportsOutcome: boolean;
  /** The `// outcome-ok:` reason, when one is given. */
  exemptReason: string | null;
}

export interface SaveOutcomeFinding {
  file: string;
  name: string;
  why: string;
}

/**
 * What counts as CHANGING something.
 *
 * Deliberately generous: a helper this list does not know about reads as a
 * non-writer and is then exempt from the rule the guard exists to enforce, which
 * is the failure mode a hand written registry always has (L96). So it matches
 * the supabase write verbs, `rpc`, and the repo's own write helpers by name.
 */
const WRITE_SHAPES = [
  /\.insert\s*\(/,
  /\.update\s*\(/,
  /\.delete\s*\(/,
  /\.upsert\s*\(/,
  /\.rpc\s*\(/,
  /\breplaceUserSchedule\s*\(/,
  /\bapplyOrgDefaultToUser\s*\(/,
  /\bapplyBookableBy/,
  /\bapplyLifecycleBy/,
  /\brecordAudit\s*\(/,
  // #2384: the batch replay re-fires every dead lettered delivery to a live
  // receiver, which is as outward as a write gets, and it reached none of the
  // shapes above, so the one action on that page nobody had ever seen report
  // anything was also the one the rule did not judge.
  /\breplayDeadLetteredDeliveries\s*\(/,
];

/**
 * The THREE ways an action can confirm a SAVE, and all three are real, which is
 * why the rule is not "must redirect".
 *
 * A guard that knew only the redirect would demand one from the business hours
 * week, whose form already draws its own confirmation through `useActionState`.
 * A false positive on the one form that got this right is how a rule stops being
 * obeyed and starts being switched off.
 *
 * A `throw` is deliberately NOT one of them, and it was, in the first version of
 * this file. Its own real-tree control is what caught that: with the fix reverted
 * in memory, the two actions this guard was written for still passed, because
 * both validate their input and therefore throw somewhere. A throw is the ERROR
 * path. The defect here is entirely on the SUCCESS path, so accepting a throw
 * would have exempted nearly every action from the rule while the suite stayed
 * green (L178: a check satisfied by an unrelated part of the same text proves
 * neither half).
 */
const OUTCOME_SHAPES = [
  // 1. A redirect carrying a named save outcome.
  /savedQuery\s*\(/,
  /redirect\s*\([^)]*\?ok=/,
  // 2. A redirect carrying some other named result the page renders
  //    (`?bookable=`, `?synced=`, `?imp_error=` and so on).
  /redirect\s*\(\s*[`"'][^`"']*\?[a-z_]+=/,
  /redirect\s*\(\s*`[^`]*\$\{[^}]*\}[^`]*\?[a-z_]+=/,
  // 3. A value returned to a form, which `useActionState` draws.
  /\breturn\s*\{/,
];

/** A `// outcome-ok: <reason>` on, or in the comment block above, a line. */
function exemptionAbove(lines: string[], at: number): string | null {
  return markerAbove(lines, at, "outcome-ok");
}

/** Split a source file into its exported server actions. */
export function scanActions(src: string): ScannedAction[] {
  const lines = src.split("\n");
  const out: ScannedAction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export async function ([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    // The body runs to the next top-level `}`, which is the only closing brace
    // in column zero.
    let end = i + 1;
    while (end < lines.length && lines[end] !== "}") end++;
    const body = lines.slice(i, end).join("\n");
    out.push({
      name: m[1],
      writes: WRITE_SHAPES.some((r) => r.test(body)),
      reportsOutcome: OUTCOME_SHAPES.some((r) => r.test(body)),
      exemptReason: exemptionAbove(lines, i),
    });
  }
  return out;
}

/** Which actions a file uses as a FORM's action, which is what makes them a
 *  subject of this rule: an action nothing submits to has no person waiting on
 *  a confirmation. */
export function scanFormActions(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/\b(?:action|formAction|removeAction|defaultsAction)=\{([^}]+)\}/g)) {
    // `action={editing ? updateBucket : createBucket}` names two.
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(id[0]);
  }
  return [...names];
}

/**
 * The findings for one actions file, given the set of action names that are
 * actually submitted to by some form.
 */
export function findSilentActions(
  file: string,
  src: string,
  submitted: ReadonlySet<string>,
): SaveOutcomeFinding[] {
  const found: SaveOutcomeFinding[] = [];
  for (const a of scanActions(src)) {
    if (!submitted.has(a.name)) continue;
    if (!a.writes) continue;
    if (a.reportsOutcome) continue;
    if (a.exemptReason) continue;
    found.push({
      file,
      name: a.name,
      why: "changes something, is submitted to by a form, and reports nothing back",
    });
  }
  return found;
}

/** An exemption with no reason is evidence nobody reasoned about it (L233). */
export function findReasonlessExemptions(file: string, src: string): SaveOutcomeFinding[] {
  const found: SaveOutcomeFinding[] = [];
  for (const line of src.split("\n")) {
    const m = readOptOutOnLine(line, "outcome-ok:");
    if (m.present && m.reason.length < 12) {
      found.push({ file, name: line.trim().slice(0, 60), why: "outcome-ok with no real reason" });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rule three (#2385): a REFUSAL the action computed has to reach the person.
//
// Next replaces a server action's error message in production, so
// `throw new Error("A bucket with code 411 already exists.")` arrives as the
// generic error boundary: "something went wrong, reload and check whether it
// went through". The sentence the action wrote is read by nobody, and the advice
// the boundary gives cannot change the state the person is stuck in (L111), so
// they retype the same code and meet the same screen for ever.
//
// The division this enforces:
//
//   a REFUSAL is a sentence about the REQUEST, something the reader submitted
//   and can change, so it travels back to the page they submitted from;
//
//   a FAULT is a sentence about the SYSTEM, a write Postgres refused or a row
//   that did not come back, which no retyping fixes. It throws, the boundary
//   truthfully says the state is unknown, and the detail goes to the log.
//
// SCOPE, so a green run is never read as more than it is. This sees throws
// inside the exported action itself. A throw raised by a HELPER the action calls
// (`replaceUserSchedule`, `replaceBucketMembers`) is not flagged: both of those
// are faults, and widening the scan to follow calls would need it to decide
// which of a helper's throws belongs to which caller.
// ---------------------------------------------------------------------------

/** One `throw new Error(...)` inside an exported action. */
export interface ScannedThrow {
  action: string;
  /** 1-based, so a finding can be opened. */
  line: number;
  /** The thrown expression, as written. */
  text: string;
  /** The `// throw-ok:` reason, when one is given. */
  exemptReason: string | null;
}

/**
 * Is this thrown expression a FAULT, quoting the failure it met, rather than a
 * refusal stating a rule the reader broke?
 *
 * Judged per SENTENCE, not over the whole expression, and that is the half that
 * matters. The bucket throws are a ternary carrying both at once:
 *
 *   throw new Error(
 *     error.code === "23505"
 *       ? `A bucket with code ${code} already exists.`     // a refusal
 *       : `The bucket could not be saved: ${error.message}` // a fault
 *   );
 *
 * A test over the whole text sees `error.message`, calls the throw a fault, and
 * exempts the refusal sitting beside it, which is the exact site #2385 was
 * opened about. So one readable sentence that does not quote an error makes the
 * whole throw a refusal.
 */
function isFault(text: string): boolean {
  // `writeRefused` logs the error and returns its message, so every sentence it
  // builds quotes one.
  if (/\bwriteRefused\s*\(/.test(text)) return true;
  const sentences = [...text.matchAll(/[`"']((?:[^`"'\\]|\\.)*)[`"']/g)]
    .map((m) => m[1])
    .filter((s) => s.trim().split(/\s+/).length >= 3);
  if (!sentences.length) return /\.message\b/.test(text);
  return sentences.every((s) => /\.message\b/.test(s));
}

/** Read a parenthesised argument list. `open` is the index of the `(`. */
function readCall(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Which exported action a character offset falls inside, or null. */
function actionAt(src: string, offset: number): string | null {
  let at = 0;
  let current: string | null = null;
  for (const line of src.split("\n")) {
    const m = line.match(/^export async function ([A-Za-z_$][\w$]*)\s*\(/);
    if (m) current = m[1];
    else if (line === "}") current = null;
    at += line.length + 1;
    if (at > offset) return current;
  }
  return null;
}

/** A `// <token>: <reason>` on, or in the comment block above, a line. */
function markerAbove(lines: string[], at: number, token: string): string | null {
  const found = readOptOut(lines, at, `${token}:`, { reach: 12 });
  return found.present && found.reasoned ? found.reason : null;
}

export function scanThrows(src: string): ScannedThrow[] {
  const lines = src.split("\n");
  const out: ScannedThrow[] = [];
  for (const m of src.matchAll(/throw new Error\s*\(/g)) {
    const at = m.index ?? 0;
    const action = actionAt(src, at);
    if (!action) continue;
    const line = src.slice(0, at).split("\n").length;
    out.push({
      action,
      line,
      text: readCall(src, at + m[0].length - 1).replace(/\s+/g, " ").trim(),
      exemptReason: markerAbove(lines, line - 1, "throw-ok"),
    });
  }
  return out;
}

/** The throws that are refusals written for a person and cannot reach one. */
export function findThrownRefusals(
  file: string,
  src: string,
  submitted: ReadonlySet<string>,
): SaveOutcomeFinding[] {
  const found: SaveOutcomeFinding[] = [];
  for (const t of scanThrows(src)) {
    if (!submitted.has(t.action)) continue;
    if (t.exemptReason) continue;
    if (isFault(t.text)) continue;
    found.push({
      file: `${file}:${t.line}`,
      name: t.action,
      why: `throws a refusal written for a person to read (${t.text.slice(0, 64)}), which production replaces with the error boundary`,
    });
  }
  return found;
}

/** A `throw-ok` with no reason is evidence nobody reasoned about it (L233). */
export function findReasonlessThrowExemptions(file: string, src: string): SaveOutcomeFinding[] {
  const found: SaveOutcomeFinding[] = [];
  for (const line of src.split("\n")) {
    const m = readOptOutOnLine(line, "throw-ok:");
    if (m.present && m.reason.length < 12) {
      found.push({ file, name: line.trim().slice(0, 60), why: "throw-ok with no real reason" });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rule four (#2384): the route a redirect NAMES has to be a page that READS the
// parameter it is carrying.
//
// Shape 2 above accepts any redirect carrying a query without ever asking where
// it goes. The webhooks page's three actions pointed at `/admin`, which takes no
// search params at all, so every outcome they wrote (including the refusal of an
// `http://` endpoint, a refusal that saves nothing) was composed, encoded,
// attached to a URL and thrown away, while every part read as wired up.
//
// SCOPE: a redirect whose route comes from a variable (`${back}`, `${availability}`)
// cannot be resolved by reading one file, so it is counted as UNJUDGED and
// reported rather than passed in silence (L98).
// ---------------------------------------------------------------------------

export interface ScannedRedirect {
  action: string;
  line: number;
  /** The literal route, an interpolated segment written as `*`, or null when the
   *  route itself came from a variable this scan cannot resolve. */
  route: string | null;
  /** The query parameter the outcome travels in. */
  param: string;
}

/**
 * The route constants this file defines, so `${WEBHOOKS_PAGE}?resend=` resolves.
 *
 * Only a name defined ONCE, and only to a literal. `back` is defined three times
 * in the real actions file with three different values, and substituting one of
 * them would have the guard judging a redirect against a route it never names,
 * which is worse than leaving it unjudged and counted.
 */
function routeConstants(src: string): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const m of src.matchAll(/(?:^|\s)const ([A-Za-z_$][\w$]*)\s*=\s*[`"']([^`"'\n]*)[`"']\s*;/g)) {
    seen.set(m[1], seen.has(m[1]) ? null : m[2]);
  }
  const out = new Map<string, string>();
  for (const [k, v] of seen) if (v !== null) out.set(k, v);
  return out;
}

export function scanRedirects(src: string): ScannedRedirect[] {
  const consts = routeConstants(src);
  const out: ScannedRedirect[] = [];
  for (const m of src.matchAll(/redirect\s*\(/g)) {
    const at = m.index ?? 0;
    const action = actionAt(src, at);
    if (!action) continue;
    const arg = readCall(src, at + m[0].length - 1).trim();
    // A trailing comma is allowed: a redirect long enough to be wrapped over
    // several lines gets one from the formatter, and three of the sites this rule
    // was written for are exactly that shape.
    const lit = arg.match(/^[`"']([\s\S]*?)[`"']\s*,?\s*$/);
    if (!lit) continue;
    const body = lit[1].replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name: string) =>
      consts.has(name) ? (consts.get(name) as string) : whole,
    );
    let param: string | null = null;
    let head = body;
    const q = body.match(/\?([a-z_]+)=/);
    if (q) {
      param = q[1];
      head = body.slice(0, q.index);
    } else if (/\$\{\s*savedQuery\s*\(/.test(body)) {
      param = "ok";
      head = body.slice(0, body.indexOf("${savedQuery"));
    } else if (/\$\{\s*refusedQuery\s*\(/.test(body)) {
      param = "error";
      head = body.slice(0, body.indexOf("${refusedQuery"));
    }
    if (!param) continue;
    out.push({
      action,
      line: src.slice(0, at).split("\n").length,
      route: head.startsWith("/") ? head.replace(/\$\{[^}]*\}/g, "*") : null,
      param,
    });
  }
  return out;
}

/**
 * Does a page's route cover `route`? A `[segment]` matches an interpolated
 * segment or any literal one, which is how `/admin/agents/*` resolves to
 * `src/app/admin/agents/[id]/page.tsx`.
 */
export function routeMatches(pageRoute: string, route: string): boolean {
  const a = pageRoute.split("/").filter(Boolean);
  const b = route.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => (seg.startsWith("[") && seg.endsWith("]") ? true : seg === b[i]));
}

/** The redirects whose target cannot show what they are carrying, and the count
 *  of redirects this scan could not judge at all. */
export function findUnreadRedirectTargets(
  file: string,
  src: string,
  pages: ReadonlyMap<string, string>,
): { findings: SaveOutcomeFinding[]; judged: number; unjudged: number } {
  const findings: SaveOutcomeFinding[] = [];
  let judged = 0;
  let unjudged = 0;
  for (const r of scanRedirects(src)) {
    if (!r.route) {
      unjudged++;
      continue;
    }
    judged++;
    const target = [...pages.entries()].find(([route]) => routeMatches(route, r.route as string));
    if (!target) {
      findings.push({
        file: `${file}:${r.line}`,
        name: r.action,
        why: `redirects to ${r.route}, which is not a page`,
      });
      continue;
    }
    // DECLARED on the page's own `searchParams` type, not merely mentioned
    // anywhere in the file. A bare word match is satisfied by `res.error` on a
    // read three hundred lines away, which is how a page that reads nothing from
    // its query passes a check named for reading its query (L178).
    const reads =
      /searchParams/.test(target[1]) && new RegExp(`\\b${r.param}\\?\\s*:`).test(target[1]);
    if (!reads) {
      findings.push({
        file: `${file}:${r.line}`,
        name: r.action,
        why: `sends ?${r.param}= to ${target[0]}, which never reads it, so the outcome is destroyed`,
      });
    }
  }
  return { findings, judged, unjudged };
}
