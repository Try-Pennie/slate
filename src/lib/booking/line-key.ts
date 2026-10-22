/**
 * Which codes share one confirm line (#3325, Dan 2026-10-05): those whose WHOLE
 * fallback ladder resolves to the same pools.
 *
 * A leader's "full" verdict says nobody in any rung of ITS ladder was free, so it may
 * settle a follower only when the follower would have walked the same pools at every
 * rung. Today the legal digit does not route and backend digits 0 and 1 resolve
 * alike, so sibling codes (510, 511, 500, 501) walk identical pools and share a line;
 * a bucket that gains a hand named member or a fallback advisor changes its pool key
 * and splits off on its own. The "excludes Low" rule each rung applies (#2842) is part
 * of the ladder too, because it changes who a rung offers.
 *
 * `peek` answers what this server holds about a code: its pool's digest, null for a
 * code with no bucket (a gap in the ladder, which is part of the ladder's identity), or
 * undefined when it holds no fresh grouping. One unknown rung gives no ladder at all,
 * and the confirm uses its code's own line rather than guess, because a wrong guess
 * could tell a lead the time is taken when it is not.
 *
 * #3460: the confirm's OWN code is never a gap. Its bucket must exist for the confirm
 * to book at all, so a grouping that does not list it was read before the bucket
 * existed, or is partial or empty, and any lower rung it calls a gap may be one too.
 * Read as a gap, an empty grouping would make every ladder of one length alike and put
 * different pools in one line, so it gives no ladder, said as `own-code-missing`.
 *
 * Pure, no `@/` imports, so node tests load it directly.
 */
import { tierLadder, rungExcludesLow } from "../routing/tiers.ts";
import { cyrb53 } from "../cyrb53.ts";

/**
 * A short, stable name for a ladder: two independent 53 bit hashes of its pools.
 * Short because it names a Durable Object; two of them because a collision would put
 * two different ladders in one line, which is the one thing this key must not do.
 */
function fingerprint(text: string): string {
  return `${cyrb53(text, 1)}${cyrb53(text, 7919)}`;
}

/**
 * The short name of one pool, as a grouping holds it (#3460): the same two hash
 * fingerprint the ladder key uses, so it fits the confirm line object's string cap and
 * a published grouping carries sixty of them rather than sixty pool keys spelled out.
 * Every server derives it here, from a local read and from a snapshot alike, so the two
 * routes can never disagree about a ladder.
 */
export function poolKeyDigest(poolKey: string): string {
  return fingerprint(poolKey);
}

/** A code's ladder group, or why there is none. */
export type LadderRead =
  | { group: string }
  /** `unknown-rung`: no fresh grouping is held. `own-code-missing`: one is held and does not list the code. */
  | { group: null; why: "unknown-rung" | "own-code-missing" };

/** The ladder group a code's confirms share, or why the confirm keeps its code's own line. */
export function ladderGroupRead(code: string, peek: (code: string) => string | null | undefined): LadderRead {
  const parts: [string | null, boolean][] = [];
  for (const rung of tierLadder(code)) {
    const pool = peek(rung);
    if (pool === undefined) return { group: null, why: "unknown-rung" };
    if (pool === null && rung === code) return { group: null, why: "own-code-missing" };
    parts.push([pool, rungExcludesLow(code, rung)]);
  }
  return { group: `ladder:${fingerprint(JSON.stringify(parts))}` };
}

/** The ladder group a code's confirms share, or null when this server cannot say. */
export function ladderGroupOf(code: string, peek: (code: string) => string | null | undefined): string | null {
  return ladderGroupRead(code, peek).group;
}

/**
 * The group a bucket code's confirms line up in (#3325): the code's ladder group when
 * `lineGroupOf` knows it, else the code's own line. The ONE place the rule lives, so a
 * wake sent while a lead reads availability (#3775) reaches the line their confirm will
 * join (`confirmQueueKey`). A named link's line is the advisor's, decided there.
 */
export function codeLineGroup(code: string, lineGroupOf?: (code: string) => string | null): string {
  return lineGroupOf?.(code) ?? `code:${code}`;
}

/** Which line a wake reaches, or why none: each reason its own (L11). */
export type LineWakeTarget =
  | { kind: "wake"; group: string }
  /** The grouping could not be read, so which line the confirm joins is unknown. */
  | { kind: "unreadable"; err: unknown }
  /** The grouping was read and still does not settle this code's line. */
  | { kind: "unknown" };

/**
 * The line to wake for a lead reading availability on `code` (#3775): the line their
 * confirm will join. With no fresh grouping held (`unknown-rung`), which is every fresh
 * server and exactly where an idle object's slow first call lands, it reads the grouping
 * first (`warm`, the confirm path's own background read) and asks again. No line when
 * the grouping still cannot be told, because waking the code's own line would wake one
 * the confirm, after settling the grouping, may not join.
 */
export async function lineGroupToWake(
  code: string,
  peek: (code: string) => string | null | undefined,
  warm: () => Promise<void>,
): Promise<LineWakeTarget> {
  let read = ladderGroupRead(code, peek);
  if (read.group === null && read.why === "unknown-rung") {
    try {
      await warm();
    } catch (err) {
      return { kind: "unreadable", err };
    }
    read = ladderGroupRead(code, peek);
    if (read.group === null && read.why === "unknown-rung") return { kind: "unknown" };
  }
  const group = read.group;
  return { kind: "wake", group: codeLineGroup(code, () => group) };
}
