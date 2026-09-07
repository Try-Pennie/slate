// Audits a committed design record against the product's real tokens.
//
// A design record's whole authority is its numbers: "8.61:1" is the reason
// somebody is allowed to put mustard on a functional surface, and a record whose
// figures have drifted is worse than no record, because it is believed. Two ways
// it rots, and this audit covers both:
//
//   1. a colour in the record is not a colour the product actually has, so the
//      specimen is drawn in something nobody can use (an invented near black is
//      exactly how this shipped the first time);
//   2. a stated ratio is not what those two colours really measure, either
//      because it was mistyped or because a token moved underneath it.
//
// The colours are read out of the RECORD and the tokens out of globals.css, so
// nothing here holds a third copy of either (L107). The audit is a pure function
// over text, so its own refusals can be driven from fixtures rather than needing
// a broken record committed to prove it works (L1).
import { parseColor, ratio, type RGB } from "./wcag-contrast.ts";

export type Problem = { kind: string; detail: string };

/** A ratio the record STATES, and the two token names it is a claim about. */
export type Claim = { label: string; a: string; b: string };

/**
 * The rows of the record's measurement table that are contrast claims, mapped to
 * the pair each one is about. The mapping is the test's knowledge (a sentence
 * cannot say which two colours it means), but the VALUES come from the record.
 */
export const CONTRAST_CLAIMS: Claim[] = [
  { label: "graphite label on the mustard strip", a: "graphite", b: "mustard" },
  { label: "mustard strip against the rose bar below it", a: "mustard", b: "rose" },
  { label: "darkest stripe against the beige page", a: "stripe-dark", b: "page-light" },
  { label: "mustard stripe against the dark page", a: "mustard", b: "page-dark" },
];

/** Every `--name: value` in the sheet, including later theme overrides. */
export function readAllDecls(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /--([a-z0-9-]+)\s*:\s*([^;}]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1].toLowerCase(), m[2].trim()]);
  return out;
}

/** Reads `--name: value` declarations out of a stylesheet or a <style> block. */
export function readDecls(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /--([a-z0-9-]+)\s*:\s*([^;}]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const name = m[1].toLowerCase();
    // First declaration wins, so :root is not overwritten by a later theme block.
    if (!out.has(name)) out.set(name, m[2].trim());
  }
  return out;
}

/** Every colour literal the record's own stylesheet paints with. */
export function colorLiterals(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = stripped.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi) ?? [];
  return found
    // A translucent colour is a tint over an unknown ground, so it is not a token
    // claim and cannot be checked against one.
    .filter((c) => !/rgba\(/i.test(c))
    .map((c) => c.trim());
}

function near(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export type AuditInput = {
  /** The record's HTML, including its <style> block. */
  record: string;
  /** src/app/globals.css. */
  globals: string;
  /** DESIGN.md, which must quote the same figures as the record. */
  designMd: string;
  /** How the record names each colour the claims refer to. */
  palette: Record<string, string>;
};

/**
 * Returns every problem found. An EMPTY array means the record's colours are all
 * real tokens and every stated ratio is what those colours measure.
 */
export function auditRecord(input: AuditInput): Problem[] {
  const problems: Problem[] = [];
  const decls = readDecls(input.record);

  // 1. Resolve the record's own palette names to colours it actually declares.
  const resolved = new Map<string, RGB>();
  for (const [key, declName] of Object.entries(input.palette)) {
    const raw = decls.get(declName.replace(/^--/, "").toLowerCase());
    if (!raw) {
      problems.push({ kind: "palette-missing", detail: `the record declares no --${declName}, so "${key}" cannot be resolved` });
      continue;
    }
    try {
      resolved.set(key, parseColor(raw));
    } catch {
      problems.push({ kind: "palette-unreadable", detail: `--${declName} is ${JSON.stringify(raw)}, which is not a colour` });
    }
  }

  // 2. Every colour the record paints with must be a colour the product has.
  //    A record drawn in an invented value describes something unbuildable.
  const productColors: RGB[] = [];
  for (const [name, raw] of readAllDecls(input.globals)) {
    if (!/^(pennie-|bg|surface|fg|error|border|accent)/.test(name)) continue;
    if (/^var\(/.test(raw)) continue;
    try {
      productColors.push(parseColor(raw));
    } catch {
      /* a non-colour token (a shadow, a radius) is not our business */
    }
  }
  for (const literal of colorLiterals(input.record)) {
    let rgb: RGB;
    try {
      rgb = parseColor(literal);
    } catch {
      continue;
    }
    // White and pure transparent-ish neutrals used for document chrome are not
    // product claims; only the specimen's own palette is audited, which is why
    // this checks the declared palette rather than every literal on the page.
    if (!Object.values(input.palette).some((d) => {
      const v = decls.get(d.replace(/^--/, "").toLowerCase());
      if (!v) return false;
      try { return near(parseColor(v), rgb); } catch { return false; }
    })) continue;
    if (!productColors.some((p) => near(p, rgb))) {
      problems.push({
        kind: "colour-not-a-token",
        detail: `the record paints with ${literal}, which is not any colour in globals.css`,
      });
    }
  }

  // 3. Every stated ratio must be what the two colours really measure.
  for (const claim of CONTRAST_CLAIMS) {
    const stated = statedRatio(input.record, claim.label);
    if (stated === null) {
      problems.push({ kind: "claim-missing", detail: `the record states no ratio for "${claim.label}"` });
      continue;
    }
    const a = resolved.get(claim.a);
    const b = resolved.get(claim.b);
    if (!a || !b) continue; // already reported above
    const real = ratio(a, b);
    // Compared at the precision the record itself prints, so a record saying
    // 8.61 is held to 8.61 and one saying 15.8 is held to 15.8.
    const dp = (stated.text.split(".")[1] ?? "").length;
    const rounded = Number(real.toFixed(dp));
    if (rounded !== stated.value) {
      problems.push({
        kind: "ratio-wrong",
        detail: `"${claim.label}" is stated as ${stated.text}:1 but measures ${real.toFixed(2)}:1`,
      });
    }
  }

  // 4. DESIGN.md must quote the same figures. Two documents stating one fact drift
  //    silently, and the rule in DESIGN.md is the one a future reader will act on.
  const hazard = /\*\*The Hazard Rule\.\*\*([\s\S]*?)(?=\n\n\*\*|\n\n##|$)/.exec(input.designMd);
  if (!hazard) {
    problems.push({ kind: "hazard-rule-missing", detail: "DESIGN.md has no Hazard Rule, so the record's exception is unrecorded" });
  } else {
    for (const claim of CONTRAST_CLAIMS) {
      const stated = statedRatio(input.record, claim.label);
      if (!stated) continue;
      if (!hazard[1].includes(stated.text)) {
        problems.push({
          kind: "design-md-drift",
          detail: `the Hazard Rule does not quote ${stated.text}, the record's figure for "${claim.label}"`,
        });
      }
    }
  }

  return problems;
}

/** The `N.NN:1` printed on the record's row for `label`. */
export function statedRatio(record: string, label: string): { text: string; value: number } | null {
  const idx = record.indexOf(label);
  if (idx < 0) return null;
  const after = record.slice(idx, idx + 400);
  const m = /([0-9]+(?:\.[0-9]+)?):1/.exec(after);
  if (!m) return null;
  return { text: m[1], value: Number(m[1]) };
}
