// Repo invariant (#2159): the standalone booker is centred in a way that cannot
// put the top of the card above the scroll origin, where it is unreachable and
// nothing reports a fault.
//
// Measured in Chrome at 1280 by 360 against the real 475px card, which is the
// ordinary size once a day is picked and a column of times renders:
//
//   minimum height + auto margin ........ card top   32   (shipped)
//   minimum height + justify-center ..... card top   32
//   FIXED height   + justify-center ..... card top  -89   unreachable
//   FIXED height   + auto margin ........ card top   32
//
// So the height being a MINIMUM is what keeps it safe today, and the auto margin
// is what keeps it safe if that is ever lost. Both are asserted, because either
// one alone reads as the whole protection and is not.
//
// The shell also has to be SHARED. Two standalone booker routes render the same
// page (`/book` for the embed and cal style links, `/booking/[id]` for the
// Salesforce id links), and before this they each wrote their own bare <main>.
// A layout decided twice drifts, so both must reach it through this module.
// Run: node --experimental-strip-types scripts/test-standalone-booker-shell.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import {
  STANDALONE_MAIN,
  STANDALONE_CONTENT,
  centresWithoutClipping,
} from "../src/lib/booking/page-shell.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** Every route that renders the standalone booker. Named, so a third one added
 *  later fails here rather than quietly writing its own layout. */
const STANDALONE_ROUTES = [
  "src/app/book/page.tsx",
  "src/app/booking/[id]/page.tsx",
];

// 1. There is room to centre in. Centring inside a container that is only as tall
//    as its content is a no-op, and reads in review as though it were done.
{
  assert(
    /\bmin-h-dvh\b/.test(STANDALONE_MAIN),
    "the shell gives the page the viewport's height to centre within",
  );
  assert(
    /\bflex\b/.test(STANDALONE_MAIN) && /\bflex-col\b/.test(STANDALONE_MAIN),
    "the shell is a column, so the booker and the footer are laid out down the page",
  );
}

// 2. The height is a floor, not a ceiling, and the centring is an auto margin.
{
  assert(
    /\bmin-h-/.test(STANDALONE_MAIN),
    "the shell's viewport height is a MINIMUM, so the page grows rather than clipping",
  );
  assert(
    /\bm[ytb]?-auto\b/.test(STANDALONE_CONTENT),
    "the booker is centred with an auto margin",
  );
  assert(
    centresWithoutClipping(STANDALONE_CONTENT) && centresWithoutClipping(STANDALONE_MAIN),
    "no part of the shell fixes the viewport height or centres with a clipping property",
  );
}

// 3. The positive control. A judge that cannot tell the clipping technique from
//    the safe one would pass both of the assertions above without reading
//    anything, and a guard that has never refused is not a guard (L1).
{
  assert(
    !centresWithoutClipping("flex h-dvh flex-col justify-center"),
    "the judge REFUSES the measured combination that reaches card top -89",
  );
  assert(
    !centresWithoutClipping("flex h-screen flex-col"),
    "the judge REFUSES a fixed viewport height on its own",
  );
  assert(
    !centresWithoutClipping("my-auto items-center"),
    "an auto margin does not excuse an items-center beside it",
  );
  assert(
    centresWithoutClipping("m-auto w-full px-4 py-8"),
    "the judge accepts a plain auto margin",
  );
  assert(
    centresWithoutClipping("flex min-h-dvh flex-col"),
    "the judge accepts a minimum height, which is what the shell uses",
  );
}

// 4. Both routes reach the layout through this module rather than writing a
//    <main> of their own (L613: the component and the guard, in one change).
for (const rel of STANDALONE_ROUTES) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  assert(
    /from "@\/lib\/booking\/page-shell"/.test(src) ||
      /from "@\/components\/StandaloneBookerShell"/.test(src),
    `${rel} takes its page layout from the shared shell`,
  );
  // The Booker may not sit inside a <main> the route wrote itself, which is the
  // shape this replaced. A route may still carry its OWN <main> for something
  // else: /book renders a one line refusal for a synthetic test bucket, and
  // centring a single sentence with items-center cannot make anything
  // unreachable. So the rule is about what the element CONTAINS, not about
  // whether the route has one.
  for (const block of src.match(/<main[\s\S]*?<\/main>/g) ?? []) {
    assert(
      !block.includes("<Booker"),
      `${rel} renders the Booker through the shared shell, not a <main> of its own`,
    );
  }
}

finish();
