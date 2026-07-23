// Repo invariant (#216 / audit AUD-076): the booking horizon must have ONE source
// of truth. It used to be a hardcoded `const HORIZON_DAYS = 4` in Booker.tsx that
// "mirrors the server constant", so if the server value changed (exactly what #216
// makes possible), the client would silently render bookable days as unavailable.
//
// The fix makes `horizonDays` a REQUIRED prop resolved server-side, so tsc already
// forces every construction site to pass it. This guard is the belt-and-suspenders
// the acceptance criteria asks for: it fails if Booker.tsx reintroduces a hardcoded
// horizon-day constant, which would recreate the divergence the required prop
// otherwise prevents.
//
// Run: node --experimental-strip-types scripts/test-booker-horizon-source.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "src/components/Booker.tsx"), "utf8");

// The exact defunct pattern (and near variants): a local constant named for the
// horizon assigned a number literal. `horizonDays` must arrive as a prop, never be
// re-hardcoded here.
const hardcoded = /\b(?:const|let|var)\s+(?:HORIZON_DAYS|horizonDays)\s*=\s*\d/;
assert(
  !hardcoded.test(src),
  "Booker.tsx has no hardcoded horizon-day constant (horizonDays must come from the required prop, AUD-076)",
);

// Positive control: prove the regex still catches the bad shape, so the guard can't
// silently rot into a no-op if the pattern is edited.
assert(
  hardcoded.test("  const HORIZON_DAYS = 4;\n"),
  "positive control: the detector still flags a reintroduced `const HORIZON_DAYS = 4`",
);

finish();
