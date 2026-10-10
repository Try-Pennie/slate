// Guard: the manual booking smoke test (#396) must DEFAULT to the isolated
// test agent/buckets and a deliverable test mailbox — never a live production
// bucket. The root cause of the "undeliverable" bounce notices landing on real
// agents (e.g. marnold) was the default booking real round-robin agents and
// inviting a non-existent smoke+ address. This locks the safe defaults in so a
// future edit can't quietly reintroduce them. Source-text scan (importing the
// script would run it against production), same posture as the copy/dash lint.
// Run: node --experimental-strip-types scripts/test-smoke-defaults.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const src = readFileSync(join(import.meta.dirname, "smoke-booking-api.ts"), "utf8");

// Default primary/secondary buckets are the isolated test buckets.
//
// Matched on the DEFAULT VALUE next to the var name, not on how the fallback is
// spelled. These assertions pinned `?? "SMOKE"` and went red on #1494's move to
// `envOr(process.env.SMOKE_BUCKET, "SMOKE")`, which changes nothing about the rule
// they exist to protect: an assertion tied to one rendering of a value fails the
// first legitimate refinement of it (L103), and the temptation then is to re-pin
// the new spelling rather than the rule.
const defaultsTo = (name: string, value: string) =>
  new RegExp(`${name}\\s*(?:\\?\\?|,)\\s*"${value}"`).test(src);
assert(
  defaultsTo("SMOKE_BUCKET", "SMOKE"),
  'SMOKE_BUCKET defaults to the isolated "SMOKE" bucket',
);
assert(
  defaultsTo("SMOKE_BUCKET_B", "SMOKE2"),
  'SMOKE_BUCKET_B defaults to the isolated "SMOKE2" bucket (enables the cross-bucket scenario)',
);

// The dangerous live default must be gone, however the fallback is written.
const livePool = /(?:\?\?|,)\s*"411"/;
assert(
  !livePool.test(src),
  'no env default falls back to live production bucket "411"',
);
// Positive control: a rule loosened to accept a second spelling has to be shown
// still catching the thing it exists for, in BOTH spellings, or "no live default
// found" is indistinguishable from a pattern that can no longer find one (L1).
assert(
  livePool.test('const B = process.env.SMOKE_BUCKET ?? "411";') &&
    livePool.test('const B = envOr(process.env.SMOKE_BUCKET, "411");'),
  "control: the live-bucket pattern catches both the ?? and the envOr spelling",
);

// Synthetic attendees use the deliverable smoketest mailbox so invites/cancels
// land in a real inbox instead of bouncing onto the assigned agent. The address is
// built in the shared identity helper now (#3581), which smoke-booking-api uses.
const identity = readFileSync(join(import.meta.dirname, "lib", "smoke-identity.ts"), "utf8");
assert(
  /smoketest\+\$\{tag\}/.test(identity),
  "the smokeAttendee helper builds the deliverable smoketest+ mailbox address",
);
assert(
  /from "\.\/lib\/smoke-identity\.ts"/.test(src),
  "smoke-booking-api uses the shared smokeAttendee helper",
);
assert(
  !/email:\s*`smoke\+\$\{tag\}/.test(src) && !/email:\s*`smoke\+\$\{tag\}/.test(identity),
  "the old non-deliverable smoke+ attendee address is gone",
);

// Test buckets are hidden from anonymous availability reads (#396), so the
// smoke scripts must send the booking key when fetching slots, else they'd 404
// on their own SMOKE bucket. The slots helper is now shared in smoke-lib.ts
// (#530): assert it authenticates, and that this script uses the shared one.
const lib = readFileSync(join(import.meta.dirname, "smoke-lib.ts"), "utf8");
const slotsFn = lib.match(/export async function slots[\s\S]*?\n}/);
assert(
  !!slotsFn && /authorization/i.test(slotsFn[0]),
  "the shared slots() helper sends the booking key (so it can read hidden test-bucket slots)",
);
assert(
  /import\s*\{[^}]*\bslots\b[^}]*\}\s*from\s*"\.\/smoke-lib\.ts"/.test(src),
  "smoke-booking-api imports the shared slots() helper",
);

finish();
