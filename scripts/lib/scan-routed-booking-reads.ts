// The scan behind scripts/test-routed-booking-reads.ts (#2073).
//
// A booking made through an agent's own link lands in the same `bookings` table
// as every routed one, in a bucket, because a booking needs one. Every monitor,
// rate and routing analytics read that reasons about ROUTED bookings must
// therefore say so (`.eq("kind", "routed")`), or it counts a later call with a
// lead the funnel already sent as a lead the funnel just sent.
//
// A rule every read site must opt into is enforced by nobody (L621), so this scans
// the surfaces where such reads live and requires each `.from("bookings")` to do
// ONE of two things:
//
//   - filter on the kind inside the same statement: `.eq("kind", "routed")`;
//   - carry `// agent-link-ok: <why>` on or directly above the read, for a read
//     that is about real CALLS rather than routed demand (the coverage sweeps, a
//     lookup of one booking by its token), where leaving the named ones out would
//     be the defect.
//
// The statement is taken from `.from("bookings")` to the first `;` after it,
// which holds the whole chain for every shape on these surfaces, including the
// `selectAllPages` builder, which since #3273 hands its chain over without a
// `.range()` and closes with `);`. What it cannot see, said here so a green run is not read as more:
// a builder bound to a name and filtered on a LATER statement, and a read reached
// through a helper outside the scanned directories.
import { hasOptOutAtOffset } from "./opt-out.ts";

export const ROUTED_KIND_FILTER = /\.eq\(\s*["']kind["']\s*,\s*["']routed["']\s*\)/;

export interface UnfilteredRead {
  file: string;
  line: number;
}

/**
 * The source with every `//` line comment blanked to spaces, offsets preserved,
 * so a semicolon written in a comment inside a chain does not end the statement.
 * A `//` counts as a comment only at the start of a line or after whitespace,
 * which keeps a URL inside a string intact.
 */
function withoutLineComments(source: string): string {
  return source.replace(/(^|[ \t])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, " "));
}

export function scanRoutedBookingReads(file: string, source: string): UnfilteredRead[] {
  const out: UnfilteredRead[] = [];
  const code = withoutLineComments(source);
  const re = /\.from\(\s*["']bookings["']\s*\)/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const end = code.indexOf(";", m.index);
    const statement = code.slice(m.index, end === -1 ? code.length : end);
    // A write (a mutator reached before any `.select(`) is not a read of demand.
    const mutator = statement.search(/\.(insert|update|upsert|delete)\(/);
    const select = statement.search(/\.select\(/);
    if (mutator !== -1 && (select === -1 || mutator < select)) continue;
    if (ROUTED_KIND_FILTER.test(statement)) continue;
    if (hasOptOutAtOffset(source, m.index, "agent-link-ok:")) continue;
    out.push({ file, line: source.slice(0, m.index).split("\n").length });
  }
  return out;
}
