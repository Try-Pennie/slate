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

/**
 * A short, stable name for a ladder: two independent 53 bit hashes of its pools.
 * Short because it names a Durable Object; two of them because a collision would put
 * two different ladders in one line, which is the one thing this key must not do.
 */
function fingerprint(text: string): string {
  const cyrb53 = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  return `${cyrb53(1)}${cyrb53(7919)}`;
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
