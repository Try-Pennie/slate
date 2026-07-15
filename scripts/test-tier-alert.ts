import { tierFallbackAlert } from "../src/lib/routing/tier-alert.ts";
import { assert, finish } from "./lib/harness.ts";

assert(tierFallbackAlert({ requestedCode: "511", effectiveCode: "511", rungsDropped: 0 }) === null, "no drop => no alert");

const one = tierFallbackAlert({ requestedCode: "511", effectiveCode: "411", rungsDropped: 1 })!;
assert(one.key === "tier_fallback:511", "single-rung key");
assert(one.cooldownMs === 60 * 60 * 1000, "single-rung is a 60-min throttled notice");
assert(!/ALERT/.test(one.text), "single-rung text is a notice, not an alert");

const deep = tierFallbackAlert({ requestedCode: "511", effectiveCode: "311", rungsDropped: 2 })!;
assert(deep.key === "tier_fallback_deep:511", "deep-drop key is distinct");
assert(deep.cooldownMs === 5 * 60 * 1000, "deep drop escalates (shorter cooldown)");
assert(/ALERT/.test(deep.text), "deep-drop text is a loud alert");

finish();
