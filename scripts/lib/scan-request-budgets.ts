// Finds every place a call budget is opened, and the label it opens it under (#3980).
//
// `requestLabel()` (`src/lib/call-budget.ts`) is the label of the OUTERMOST budget in
// force, and the token mint and token read lines carry it as `request=`. Today exactly two
// places open a budget: the booking confirm (`withinBookingConfirmBudget`, new bookings and
// reschedules) and every Google calendar call (`gfetch` in `src/lib/google/calendar.ts`,
// labelled `google <call>`). So `request="the booking confirm"` is a lead's confirm, and any
// `google ...` label is a call made outside one: a sync lane, a cron drain, the monitor lane.
//
// The reading behind #3298 got this wrong once: it counted `google freeBusy.many`, the cron
// drains' and the monitor lane's free/busy check, as the confirm path, and reported the
// confirm's slowest mint as 2.2s when the confirm's own was 338ms. A third opener would make
// a label mean something new with nothing saying so, which is why this is a scan with an
// exact expected list rather than a comment.

/** Every budget opener in `src/` outside `call-budget.ts`, as `<file> <label as written>`. */
export const EXPECTED_BUDGET_OPENERS: readonly string[] = [
  'src/lib/booking/confirm-budget.ts "the booking confirm"',
  "src/lib/google/calendar.ts `google ${label}`",
];

/** Comments blanked in place, so a docstring QUOTING a call is not read as one (L361). A
 *  `//` is only a comment at the start of a line, so a URL in a string is left alone. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/** The arguments of the call whose `(` is at `open`, split at top level commas, as written. */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** The label (second argument, as written) of every `withinCallBudget(...)` call. */
export function findBudgetOpeners(source: string): string[] {
  const text = stripComments(source);
  const out: string[] = [];
  for (const m of text.matchAll(/\bwithinCallBudget\s*(?:<[^>()]*>)?\s*\(/g)) {
    if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    const label = callArguments(text, m.index + m[0].length - 1)[1];
    if (label !== undefined) out.push(label);
  }
  return out;
}
