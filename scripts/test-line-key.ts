// Which codes share one confirm line: those whose WHOLE fallback ladder resolves to
// the same pools (#3325, Dan 2026-10-05).
//
// A leader's "full" verdict means nobody in any rung of ITS ladder was free, so it
// settles a follower only when the follower would have walked the same pools at
// every rung. Codes that differ only in digits that no longer route (the legal digit,
// backend 0 against 1) walk the same pools and share a line; a code whose bucket
// gained a hand named member, or whose lower rung is a different pool, does not.
// A rung whose pool this isolate does not know yet gives no ladder at all, and the
// confirm uses its code's own line rather than guess.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-line-key.ts
import { ladderGroupOf } from "../src/lib/booking/line-key.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { assert, finish } from "./lib/harness.ts";

/** A pool map where the legal digit and backend 0/1 do not change the pool. */
const pools = new Map<string, string | null>();
for (let tier = 1; tier <= 5; tier++) {
  for (const backend of ["0", "1", "2", "3"]) {
    for (const legal of ["0", "1"]) {
      const kind = backend === "2" ? "beyond" : backend === "3" ? "achieve" : "all";
      pools.set(`${tier}${backend}${legal}`, `pool-${tier}-${kind}`);
    }
  }
}
const peek = (map: Map<string, string | null>) => (code: string) => (map.has(code) ? map.get(code)! : undefined);

// --- siblings that walk the same pools share one line -------------------------
const g510 = ladderGroupOf("510", peek(pools));
const g511 = ladderGroupOf("511", peek(pools));
const g500 = ladderGroupOf("500", peek(pools));
assert(typeof g510 === "string" && g510.startsWith("ladder:"), `siblings: a known ladder is a ladder group (got ${g510})`);
assert(g510 === g511, "siblings: 510 and 511 walk the same pools, so share a line");
assert(g510 === g500, "siblings: backend 0 and 1 resolve alike, so 500 shares it too");

// --- a different pool anywhere on the ladder is a different line ---------------
const edited = new Map(pools);
edited.set("411", "pool-4-all-plus-a-hand-named-member");
assert(ladderGroupOf("511", peek(edited)) !== ladderGroupOf("510", peek(edited)), "edited: a lower rung that is a different pool splits the line");
assert(ladderGroupOf("410", peek(pools)) !== g510, "tiers: a different starting tier is a different ladder");
assert(ladderGroupOf("520", peek(pools)) !== g510, "backends: a specific backend walks other pools");

// --- a rung with no bucket is part of the ladder's identity --------------------
const gap = new Map(pools);
for (const rung of tierLadder("511")) if (rung.startsWith("3")) gap.set(rung, null);
assert(typeof ladderGroupOf("511", peek(gap)) === "string", "gap: a rung known to have no bucket still gives a ladder");
assert(ladderGroupOf("511", peek(gap)) !== g511, "gap: and a different one from a ladder with that rung filled");

// --- unknown means no ladder: the code's own line, never a guess ----------------
const cold = new Map<string, string | null>();
assert(ladderGroupOf("511", peek(cold)) === null, "cold: an isolate that knows no pools gives no ladder");
const partial = new Map(pools);
partial.delete("311");
assert(ladderGroupOf("511", peek(partial)) === null, "partial: one unknown rung gives no ladder");

// --- deterministic and compact --------------------------------------------------
assert(ladderGroupOf("510", peek(pools)) === g510, "stable: the same pools always give the same group");
assert((g510 ?? "").length < 80, `compact: the group is a short name, not the pools spelled out (got ${(g510 ?? "").length} chars)`);

finish();
