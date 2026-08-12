// Static reader for the #1151 guard: which alert key does each notify call use,
// and on which channel? See scripts/test-alert-recovery-coverage.ts for the why.
//
// Three channels matter, and they are not interchangeable:
//   sendThrottledAlert - pages a human about something that needs action
//   sendThrottledInfo  - whispers something informational, needing no action
//   resolveAlert       - the all-clear for a key that was paging
//
// The keys are written several ways, so this resolves each to a canonical
// pattern rather than comparing raw expression text (which would silently fail
// to pair `staleLaneAlertKey(lane)` with the `r.key` that clears it):
//   "literal"                       -> literal
//   SOME_ALERT_KEY                  -> the literal it is defined as, same file
//   `prefix:${x}`                   -> "prefix:*"
//   someKeyFn(x), where the file
//     defines `const someKeyFn = (a) => `prefix:${a}``   -> "prefix:*"
//
// Anything it CANNOT read is returned as opaque, never guessed and never
// skipped. A guessed key would pair the wrong alert with the wrong all-clear;
// a skipped one would let an unclassified alert ship, which is the hole the
// guard exists to close. The caller turns an unannotated opaque site into a
// hard failure, exactly as the heartbeat-coverage guard does with a
// recordHeartbeat call whose lane it cannot read.

export type AlertChannel = "alert" | "info" | "resolve";

export interface AlertSite {
  channel: AlertChannel;
  /** The canonical key pattern, or null when the expression could not be read. */
  key: string | null;
  /** The raw key expression, for the failure message. */
  expression: string;
  file: string;
  line: number;
}

const CALL = /\b(sendThrottledAlert|sendThrottledInfo|resolveAlert)\s*\(\s*/g;
/**
 * The same three helpers named but NOT called: a bare REFERENCE, handed to
 * something else to call later.
 *
 * This is how the monitor lane wires its pure checks: `notify: sendThrottledAlert`.
 * It is not a call, so it produced no site, so the key living inside the pure
 * check (`deps.notify(VOLUME_ALERT_KEY, ...)`) was never seen by anything. Nine
 * keys sat in that gap, eight with no catalog entry at all and one
 * (`sync_staleness`) paging with no way to say it had ended (#1400).
 *
 * The arrow form (`notify: (key, ms, text) => sendThrottledAlert(key, ms, text)`)
 * was always covered, because that IS a call whose key cannot be read, and an
 * unannotated opaque site is a hard failure. Only the reference form escaped, and
 * a scan that recognises an action by ONE of its syntactic forms is blind to the
 * others while reading exactly like a scan that covers them all.
 */
const WIRING = /\b(sendThrottledAlert|sendThrottledInfo|resolveAlert)\b(?!\s*\()/g;
/** The batched all-clear helper: `resolveRecovered([{ key, text }, ...])`. */
const BATCH_CALL = /\bresolveRecovered\s*\(\s*/g;

const CHANNEL: Record<string, AlertChannel> = {
  sendThrottledAlert: "alert",
  sendThrottledInfo: "info",
  resolveAlert: "resolve",
};

/** The dynamic-suffix marker: `webhook_dead:${id}` and friends collapse to this. */
export const DYNAMIC = "*";

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * The first argument's source text: everything up to the comma that ends it, at
 * paren depth zero, so a key built by a call (`staleLaneAlertKey(lane.lane)`)
 * survives intact instead of being cut at its inner comma.
 */
function firstArgument(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return source.slice(start, i).trim();
      depth--;
    } else if (c === "," && depth === 0) return source.slice(start, i).trim();
  }
  return source.slice(start).trim();
}

/** `prefix:${x}` -> `prefix:*`. Returns null if the template starts dynamic. */
function templatePattern(literal: string): string | null {
  const body = literal.slice(1, -1);
  const head = body.split("${")[0];
  if (head.length === 0) return null; // no static prefix to key on
  return `${head}${DYNAMIC}`;
}

/** String constants defined in this file, e.g. `const FOO_KEY = "foo";`. */
function stringConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]| ]+)?\s*=\s*["']([^"']+)["']/g,
  )) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Key-builder arrows defined in this file, e.g.
 * `const staleLaneAlertKey = (lane: string) => `cron_lane_stale:${lane}`;`
 * mapped to their static prefix pattern.
 */
function keyBuilders(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*(`[^`]*`)/g,
  )) {
    const pattern = templatePattern(m[2]);
    if (pattern) out.set(m[1], pattern);
  }
  return out;
}

/**
 * Explicit declarations for a site whose key this scanner cannot read, written
 * on or in the `//` block directly above the call:
 *   // alert-key: booking_verify_outage
 *   // alert-key: no_eligible_agents:*
 * Same escape-hatch shape as the other guards, and like them it is a claim the
 * catalog still has to account for.
 *
 * Several are allowed, because the shape that defeats the reader is usually one
 * dispatch point serving a family of keys (an injected `notify`, a `spec.key`
 * built by a classifier). Declaring only the first would leave the rest
 * unclassified while the site looked accounted for, so each key gets its own
 * line and each is checked.
 */
function declaredKeys(lines: string[], index: number): string[] {
  const out: string[] = [];
  const own = /\/\/\s*alert-key:\s*(\S+)/.exec(lines[index] ?? "");
  if (own) out.push(own[1]);
  for (let i = index - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed.startsWith("//") && !trimmed.startsWith("*") && trimmed !== "") break;
    const m = /\/\/\s*alert-key:\s*(\S+)/.exec(trimmed);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The balanced text of a call's whole argument list, from just after the open
 * paren to its matching close. Used for the batched helper, whose keys sit
 * inside an array of object literals rather than in the first argument.
 */
function argumentBlock(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return source.slice(start, i);
      depth--;
    }
  }
  return source.slice(start);
}


/**
 * The source with imports and comments blanked to spaces, indices preserved.
 *
 * Only the bare-reference scan uses it, and it needs both exclusions: an
 * `import { sendThrottledAlert }` names the helper without calling it and is not
 * a wiring point, and prose about an alert is not one either. Spaces rather than
 * deletion so every offset still maps to the real line, and so `declaredKeys`
 * still reads the untouched lines above.
 */
function maskNonWiring(source: string): string {
  const out = source.split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\//g)) blank(m.index, m.index + m[0].length);
  for (const m of source.matchAll(/\/\/[^\n]*/g)) blank(m.index, m.index + m[0].length);
  // An import statement, single or multi line, up to its terminating semicolon.
  for (const m of source.matchAll(/^import\s[\s\S]*?;/gm)) blank(m.index, m.index + m[0].length);
  return out.join("");
}

export function scanAlertSites(source: string, file = "<source>"): AlertSite[] {
  const sites: AlertSite[] = [];
  const lines = source.split("\n");
  const constants = stringConstants(source);
  const builders = keyBuilders(source);

  for (const m of source.matchAll(CALL)) {
    const expression = firstArgument(source, m.index + m[0].length);
    const line = lineOf(source, m.index);
    let key: string | null = null;

    const literal = /^["']([^"']*)["']$/.exec(expression);
    const builderCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expression);

    if (literal) key = literal[1];
    else if (expression.startsWith("`")) key = templatePattern(expression);
    else if (constants.has(expression)) key = constants.get(expression)!;
    else if (builderCall && builders.has(builderCall[1])) key = builders.get(builderCall[1])!;

    // A declaration always wins: it is how a site whose key is genuinely built
    // elsewhere (passed in as a parameter, carried on a spec object) says what
    // it sends, instead of being silently dropped from the coverage check.
    const declared = declaredKeys(lines, line - 1);
    if (key === null && declared.length > 0) {
      for (const d of declared) {
        sites.push({ channel: CHANNEL[m[1]], key: d, expression, file, line });
      }
      continue;
    }

    sites.push({ channel: CHANNEL[m[1]], key, expression, file, line });
  }

  // The batched all-clear (`resolveRecovered([{ key, text }, ...])`) is a resolve
  // wiring point exactly as `resolveAlert` is, and a guard that saw only the
  // direct call would report every condition cleared through it as having no
  // recovery at all.
  for (const m of source.matchAll(BATCH_CALL)) {
    const block = argumentBlock(source, m.index + m[0].length);
    const line = lineOf(source, m.index);
    const inline = [...block.matchAll(/\bkey:\s*([^,\n]+)/g)];
    if (inline.length === 0) {
      // The list was built earlier (conditionally, which is the point of the
      // batched helper), so the call itself carries no readable key. The site
      // declares what it can clear, and an undeclared one stays opaque rather
      // than silently counting as no recovery at all.
      for (const d of declaredKeys(lines, line - 1)) {
        sites.push({ channel: "resolve", key: d, expression: "resolveRecovered(...)", file, line });
      }
      if (declaredKeys(lines, line - 1).length === 0) {
        sites.push({ channel: "resolve", key: null, expression: "resolveRecovered(...)", file, line });
      }
      continue;
    }
    for (const k of inline) {
      const expression = k[1].trim();
      const literal = /^["']([^"']*)["']$/.exec(expression);
      let key: string | null = null;
      if (literal) key = literal[1];
      else if (expression.startsWith("`")) key = templatePattern(expression);
      else if (constants.has(expression)) key = constants.get(expression)!;
      sites.push({ channel: "resolve", key, expression, file, line });
    }
  }

  // Bare references: `notify: sendThrottledAlert`. The key is written inside the
  // pure check that will be handed this function, so it cannot be read here and
  // the site must DECLARE what it sends, exactly as an opaque call does.
  for (const m of maskNonWiring(source).matchAll(WIRING)) {
    const line = lineOf(source, m.index);
    const channel = CHANNEL[m[1]];
    const declared = declaredKeys(lines, line - 1);
    if (declared.length > 0) {
      for (const d of declared) sites.push({ channel, key: d, expression: m[1], file, line });
    } else {
      sites.push({ channel, key: null, expression: m[1], file, line });
    }
  }
  return sites;
}
