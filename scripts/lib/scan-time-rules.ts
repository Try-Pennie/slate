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

const OPT_OUT = /\/\/\s*one-time-rule-ok:\s*\S/;

interface Rule {
  /** What a second copy looks like. */
  pattern: RegExp;
  why: string;
}

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
];

/** Every second copy of a time rule in `text`. */
export function scanTimeRules(file: string, text: string): { file: string; line: number; why: string }[] {
  const lines = text.split("\n");
  const out: { file: string; line: number; why: string }[] = [];
  lines.forEach((line, i) => {
    if (OPT_OUT.test(line)) return;
    for (let up = i - 1; up >= 0; up--) {
      const above = lines[up].trim();
      if (!above.startsWith("//") && !above.startsWith("*")) break;
      if (OPT_OUT.test(above)) return;
    }
    for (const rule of RULES) {
      if (rule.pattern.test(line)) out.push({ file, line: i + 1, why: rule.why });
    }
  });
  return out;
}

