// #1994: the predicate that recognises a save killed by a deploy.
//
// `unstable_isUnrecognizedActionError` is unstable by name and can go or change
// between Next versions. If it did, nothing would break loudly: the predicate
// would answer `false` forever, every stale save would look like an ordinary
// error again, and the crash screen this exists to remove would come back with
// no test failing anywhere.
//
// That is the specific risk the issue asks to be pinned, so it is pinned against
// the INSTALLED Next rather than against a fake of it. A hand written double
// agrees with our assumption about the interface by construction (L52), and the
// assumption is the thing at risk here.
//
// Run: node --experimental-strip-types scripts/test-stale-action.ts
import * as nav from "next/navigation";
import { assert, eq, finish } from "./lib/harness.ts";

// The export exists, on the Next that is actually installed. This is the
// assertion that fails on the upgrade that removes it.
{
  assert(
    typeof (nav as Record<string, unknown>).unstable_isUnrecognizedActionError === "function",
    "next/navigation still exports unstable_isUnrecognizedActionError",
  );
}

// It answers FALSE for the ordinary things, which is what stops a real refusal
// being reported as a stale page. A predicate that said true for everything
// would turn "Tuesday's windows overlap each other" into "reload and try again",
// which is advice that can never work (L111).
{
  const isStale = nav.unstable_isUnrecognizedActionError;
  for (const [label, value] of [
    ["an ordinary Error", new Error("the week could not be saved")],
    ["a string", "nope"],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { message: "x" }],
    ["an Error carrying a digest", Object.assign(new Error("x"), { digest: "12345" })],
  ] as [string, unknown][]) {
    eq(isStale(value), false, `${label} is not a stale action error`);
  }
}

// The copy says the three things it has to say, and is checked here rather than
// only read: it is the one sentence a person gets when a save died, and every
// part of it is a claim.
{
  const { STALE_ACTION_NOTICE, STALE_ACTION_TITLE } = await import("../src/lib/stale-action.ts");
  assert(/nothing was saved/i.test(STALE_ACTION_NOTICE), "it says nothing was saved");
  assert(/reload/i.test(STALE_ACTION_NOTICE), "it says what to do");
  assert(/kept/i.test(STALE_ACTION_NOTICE), "and that what was typed is not lost");
  assert(STALE_ACTION_TITLE.length > 0 && STALE_ACTION_TITLE.length < 60, "the heading is short");
  // No apology and no blame: the person did nothing wrong and cannot act on
  // either.
  assert(!/sorry|apolog/i.test(STALE_ACTION_NOTICE), "it does not apologise");
}

finish();
