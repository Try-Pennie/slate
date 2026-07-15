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
assert(
  /SMOKE_BUCKET\s*\?\?\s*"SMOKE"/.test(src),
  'SMOKE_BUCKET defaults to the isolated "SMOKE" bucket',
);
assert(
  /SMOKE_BUCKET_B\s*\?\?\s*"SMOKE2"/.test(src),
  'SMOKE_BUCKET_B defaults to the isolated "SMOKE2" bucket (enables the cross-bucket scenario)',
);

// The dangerous live default must be gone.
assert(
  !/\?\?\s*"411"/.test(src),
  'no env default falls back to live production bucket "411"',
);

// Synthetic attendees use the deliverable smoketest mailbox so invites/cancels
// land in a real inbox instead of bouncing onto the assigned agent.
assert(
  /smoketest\+\$\{tag\}/.test(src),
  "synthetic attendee address uses the deliverable smoketest+ mailbox",
);
assert(
  !/email:\s*`smoke\+\$\{tag\}/.test(src),
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
