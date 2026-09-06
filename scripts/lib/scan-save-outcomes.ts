/**
 * The scan behind `scripts/test-save-outcomes.ts` (#1990).
 *
 * Separate from the guard so the decision logic can be driven by hand written
 * fixtures, including ones that must be CAUGHT, which a scan run only over the
 * real tree can never demonstrate: a scanner that reads nothing and a clean tree
 * produce the same empty result (L98).
 */

/** One server action, as the scan sees it. */
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
  /\bupsertUserSchedule\s*\(/,
  /\bapplyOrgDefaultToUser\s*\(/,
  /\bapplyBookableBy/,
  /\bapplyLifecycleBy/,
  /\brecordAudit\s*\(/,
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
  for (let i = at; i >= 0 && i > at - 12; i--) {
    const m = lines[i].match(/\/\/\s*outcome-ok:\s*(.+)$/);
    if (m) return m[1].trim();
    // Stop at the first line that is neither a comment nor blank, except the
    // declaration itself, so an exemption cannot be inherited from the action
    // above this one.
    if (i !== at && lines[i].trim() && !lines[i].trim().startsWith("*") && !lines[i].trim().startsWith("//") && !lines[i].trim().startsWith("/*")) {
      return null;
    }
  }
  return null;
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
    const m = line.match(/\/\/\s*outcome-ok:\s*(.*)$/);
    if (m && m[1].trim().length < 12) {
      found.push({ file, name: line.trim().slice(0, 60), why: "outcome-ok with no real reason" });
    }
  }
  return found;
}
