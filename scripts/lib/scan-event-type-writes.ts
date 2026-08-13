/**
 * Scan logic for the event-type write guard (#1435), kept beside its test so it is
 * unit-testable with positive controls.
 *
 * The defect, hit live on 2026-08-12: the booker kept serving an old event
 * description after an admin changed it, because the event type rides INSIDE the
 * cached `bucket_slots` payload the read path serves. Editing the row is not the
 * same as serving it, and the gap is invisible from every angle that gets checked:
 * the database is correct, the admin screen shows the new value, and only a lead
 * sees the old one.
 *
 * Two admin actions happened to remember to invalidate. Nothing enforced it, and a
 * future editor for the name, duration, buffers, notice or cap would serve stale
 * values with no sign anything was wrong. A duration change is worse than
 * cosmetic, because the org-hours gate judges whether a slot FITS the window.
 *
 * So the invalidation is part of WRITING now (src/lib/availability/event-type-store.ts),
 * and this scan is the second direction: nothing else in `src/` may write the table.
 * Derived from the code rather than from a list of call sites, because a registry
 * only ever checks what somebody remembered to add (L96).
 *
 * An INSERT is not flagged. A brand new event type has no cached payload serving an
 * older version of itself, so there is nothing to invalidate.
 */

/** The chain shape: `.from("event_types")` followed by a write. */
const WRITE_AFTER_FROM =
  /\.from\(\s*["']event_types["']\s*\)\s*(?:\r?\n\s*)?\.\s*(update|upsert|delete)\s*\(/g;

/** The per site opt-out, on the line or in the `//` block directly above it. */
const OPT_OUT = /\/\/\s*event-type-write-ok:/;

export interface EventTypeWriteFinding {
  file: string;
  line: number;
  method: string;
  message: string;
}

/** Is this line, or the comment block directly above it, opted out? */
function optedOut(lines: string[], index: number): boolean {
  if (OPT_OUT.test(lines[index] ?? "")) return true;
  for (let i = index - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("//")) return false;
    if (OPT_OUT.test(line)) return true;
  }
  return false;
}

/**
 * Every `event_types` write in one file, excluding the store module itself (which
 * is where the one legitimate write lives, together with the invalidation).
 */
export function scanEventTypeWrites(file: string, source: string): EventTypeWriteFinding[] {
  const lines = source.split("\n");
  const findings: EventTypeWriteFinding[] = [];
  for (const match of source.matchAll(WRITE_AFTER_FROM)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    if (optedOut(lines, line - 1)) continue;
    findings.push({
      file,
      line,
      method: match[1]!,
      message:
        `${file}:${line}: a direct \`.${match[1]}\` on event_types. The event type rides inside ` +
        `the cached bucket_slots payload the booker serves, so a write with no invalidation ` +
        `leaves leads reading the OLD value with nothing anywhere saying so (#1435). Route it ` +
        `through updateEventType (src/lib/availability/event-type-store.ts), which invalidates ` +
        `as part of writing, or annotate with ` +
        `\`// event-type-write-ok: <why no cached payload can be serving this>\`.`,
    });
  }
  return findings;
}
