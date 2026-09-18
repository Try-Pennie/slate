/**
 * Scan for a second copy of a time rule (#1765).
 *
 * Lives in scripts/lib because `scripts/test-*.ts` is the runner's glob: a
 * scanner exported from a test file cannot be imported without running that
 * file's whole suite, which exits the importing process.
 *
 * The rules below are about the CODE rather than about the answers, because two
 * implementations are the defect whether or not they currently agree. Slate's two
 * time pickers each held their own `pad`, their own character for character copy
 * of `to24`, and their own snapping, and the snapping disagreed: the time off form
 * rounded a MINUTE in isolation, so `ceil(50 / 15)` gave 60, which is not a
 * minute, and it answered 45 with the hour untouched. A typed 5:50pm END became
 * 5:45pm. Each implementation was tested against itself, which is why it survived.
 */

import { hasOptOut } from "./opt-out.ts";

const OPT_OUT = "one-time-rule-ok:";

/**
 * The long DATE rule carries its OWN opt-out token (#2221).
 *
 * Reusing `one-time-rule-ok:` would have put a second rule behind an existing
 * exemption, so a reason somebody wrote about a machine payload's TIME would
 * silently also exempt a date that appeared on the same line later (L448). The
 * two answer different questions and are spelled differently.
 */
const DATE_OPT_OUT = "one-date-rule-ok:";

interface Rule {
  /** What a second copy looks like. */
  pattern: RegExp;
  why: string;
  /** Which marker exempts this rule. Defaults to the time one. */
  optOut?: string;
}

/** What a long date spelled by hand is called, whichever way it was built. */
const LONG_DATE_LUXON = "a long date spelled inline; use formatLongDate so there is one spelling";
const LONG_DATE_INTL = "a long date spelled inline with Intl; use formatLongDate";

const RULES: Rule[] = [
  {
    pattern: /\b(?:function|const)\s+(?:to24|from24|snapMinute|twelveHour|to12)\b/,
    why: "a second 12 hour to 24 hour conversion; import it from @/lib/date/parse",
  },
  {
    pattern: /\bconst\s+pad\s*=\s*\(/,
    why: "a local pad; @/lib/date/parse exports padTwo",
  },
  {
    // The snapping rule itself: anything dividing by 15 and multiplying back.
    pattern: /Math\.(?:ceil|floor|round)\s*\([^)]*\/\s*15\s*\)\s*\*\s*15/,
    why: "a second quarter hour snapping rule; use snapTimeOfDay",
  },
  {
    // `9:00am` built inline, in either of the two shapes the tree carried.
    pattern: /toFormat\(\s*["'][^"']*\bh{1,2}:mm\s*a?\b[^"']*["']\s*\)/,
    why: "a time spelled inline; use formatClockTime so there is one spelling",
  },
  {
    pattern: /toFormat\(\s*["']a["']\s*\)\s*\.toLowerCase\(\)/,
    why: "the lowercase meridiem built inline; use formatClockTime",
  },
  {
    // The same date built with Intl, all on one line. The multi line shape is
    // caught by the text pass below, which this cannot see.
    pattern: /Intl\.DateTimeFormat\([^)]*weekday:\s*["']long["'][^)]*month:\s*["']long["']/,
    why: LONG_DATE_INTL,
    optOut: DATE_OPT_OUT,
  },
];

/**
 * A Luxon format naming BOTH a full weekday and a full month, in either order.
 * That pair is the long date and nothing else: `cccc` alone is a bare weekday and
 * `LLLL yyyy` alone is a month heading, and both stay allowed.
 *
 * It is a TEXT pass rather than a line rule because prettier puts the format
 * string on its own line whenever the call is long, and two of the nine sites
 * this was written for looked exactly like that. A line rule reported them clean,
 * which is the failure this guard exists to prevent (L98): a scanner blind to the
 * shape and a clean tree produce the same empty list.
 *
 * The finding is anchored to the line the STRING is on rather than the `toFormat`,
 * so the opt-out sits where a reader would put it.
 */
function scanLuxonLongDate(
  file: string,
  text: string,
  exempt: (lineIndex: number, optOut: string) => boolean,
): { file: string; line: number; why: string }[] {
  const out: { file: string; line: number; why: string }[] = [];
  const call = /toFormat\(\s*(["'][^"']*["'])/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text)) !== null) {
    const fmt = m[1];
    if (!fmt.includes("cccc") || !fmt.includes("LLLL")) continue;
    const line = text.slice(0, m.index + m[0].length - fmt.length).split("\n").length - 1;
    if (exempt(line, DATE_OPT_OUT)) continue;
    out.push({ file, line: line + 1, why: LONG_DATE_LUXON });
  }
  return out;
}

/**
 * The long date built with `Intl.DateTimeFormat` across SEVERAL lines, which is
 * the shape `ManageBooking` carried and which no line based rule can see: its
 * `weekday: "long"` and `month: "long"` sat four lines apart.
 *
 * The options object is matched rather than the whole call, so a nested call in
 * a later argument cannot run the match past the end of it.
 */
function scanMultilineIntl(
  file: string,
  text: string,
  exempt: (lineIndex: number, optOut: string) => boolean,
): { file: string; line: number; why: string }[] {
  const out: { file: string; line: number; why: string }[] = [];
  const call = /new\s+Intl\.DateTimeFormat\s*\([^{]*\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text)) !== null) {
    const opts = m[1];
    if (!/weekday:\s*["']long["']/.test(opts)) continue;
    if (!/month:\s*["']long["']/.test(opts)) continue;
    const line = text.slice(0, m.index).split("\n").length - 1;
    if (exempt(line, DATE_OPT_OUT)) continue;
    out.push({ file, line: line + 1, why: LONG_DATE_INTL });
  }
  return out;
}

/** Every second copy of a time or long date rule in `text`. */
export function scanTimeRules(file: string, text: string): { file: string; line: number; why: string }[] {
  const lines = text.split("\n");
  /** Whether `marker` sits on this line, or in the comment block directly above it. */
  const exempt = (i: number, marker: string): boolean => hasOptOut(lines, i, marker);
  const out: { file: string; line: number; why: string }[] = [];
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      // Per rule, so an exemption written about one rule never widens to another
      // (L448).
      if (exempt(i, rule.optOut ?? OPT_OUT)) continue;
      if (rule.pattern.test(line)) out.push({ file, line: i + 1, why: rule.why });
    }
  });
  return [
    ...out,
    ...scanLuxonLongDate(file, text, exempt),
    ...scanMultilineIntl(file, text, exempt),
  ];
}

