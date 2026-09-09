// #2158: the notice that says a legal booking was routed to somebody not cleared
// for legal work. The relaxation is only acceptable because this is sent, so the
// cases that matter are the ones where it must NOT be silent.
// Run: node --experimental-strip-types scripts/test-legal-alert.ts
import { assert, finish } from "./lib/harness.ts";
import { legalRelaxedAlert } from "../src/lib/routing/legal-alert.ts";
import { tierFallbackAlert } from "../src/lib/routing/tier-alert.ts";

// 1. It fires, and names the thing a reader has to act on.
{
  const a = legalRelaxedAlert({ requestedCode: "411", pooledAgents: 17 });
  assert(a !== null, "a relaxed booking produces a notice");
  assert(a!.key === "legal_relaxed:411", `keyed per bucket, got ${a!.key}`);
  assert(a!.text.includes("411"), "names the bucket");
  assert(a!.text.includes("not marked legal eligible"), "says what the compromise WAS");
  assert(a!.text.includes("17 agents"), "says how wide the pool it used actually is");
  // The tier by NAME. A bare digit is a code fragment leaking into a sentence read
  // on a phone, and the preview is what showed it.
  assert(a!.text.includes("Very High tier"), `names the tier, got: ${a!.text}`);
  assert(!/\bthe 4 tier\b/.test(a!.text), "never the raw digit");
  assert(!/\bcheck back\b/i.test(a!.text), "does not tell anyone to wait and see");
}

// 2. Nothing relaxed is nothing said. A notice sent on every booking would be
//    ignored within a week, which is the failure this whole design rests on not
//    happening (L36).
{
  assert(legalRelaxedAlert({ requestedCode: "411", pooledAgents: 0 }) === null, "no pool, no notice");
  assert(legalRelaxedAlert({ requestedCode: "412", pooledAgents: -1 }) === null, "a negative count is not a relaxation");
}

// 3. One agent reads as one agent. A count folded into a plural is the kind of
//    thing that gets read past, and "1 agents" is how a reader learns the sentence
//    is generated rather than considered.
{
  const one = legalRelaxedAlert({ requestedCode: "521", pooledAgents: 1 });
  assert(one!.text.includes("(1 agent)"), `singular, got: ${one!.text}`);
}

// 4. It cannot be confused with the tier drop, which is a different decision with
//    a different remedy. Two notices sharing a key would throttle each other into
//    silence, and the one that lost would be invisible (L53).
{
  const legal = legalRelaxedAlert({ requestedCode: "411", pooledAgents: 17 })!;
  const tier = tierFallbackAlert({ requestedCode: "411", effectiveCode: "311", rungsDropped: 1 })!;
  assert(legal.key !== tier.key, "distinct keys");
  assert(legal.text !== tier.text, "distinct wording");
}

finish();
