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

const src = readFileSync(join(import.meta.dirname, "smoke-booking-api.ts"), "utf8");

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error("FAIL:", m);
    failures++;
  } else console.log("ok:", m);
};

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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
