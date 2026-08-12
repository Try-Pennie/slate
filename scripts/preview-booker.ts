// Print every string a LEAD can read, rendered (#1343).
//
// The point of this file is to be READ. Run it before changing any wording on the
// booker or the manage page, and read the diff in review. It is the counterpart of
// `pnpm preview:alerts`, for the copy that actually reaches customers rather than
// the copy that reaches an on-call phone.
//
// It calls the real copy builders and holds no wording of its own, so what prints
// here is what ships. See src/lib/booking/copy-preview.ts.
//
// Run: pnpm preview:booker
import { bookerCopyScreens, inviteCopyScreens } from "../src/lib/booking/copy-preview.ts";
import { embedCopyEntries, embedCopyState } from "../src/lib/booking/embed-copy.ts";

/**
 * The embed's chrome, read out of the shipping `widget.js` (#1421). It cannot be a
 * builder like the rest: it is a dependency-free static asset served to
 * third-party pages, so it imports nothing. Reading the artifact gives the same
 * guarantee by the other route, and the guard keeps its copy block the only place
 * that wording can live.
 */
const embedScreen = {
  screen: "Embedded booker: the modal around it",
  purpose:
    "How most real leads meet Slate. Everything here is chrome the host page cannot " +
    "style, so it is Slate speaking on somebody else's site.",
  lines: embedCopyEntries().map((e) => ({
    state: embedCopyState(e.key),
    text: e.text,
    // Four of the seven are only ever heard, never seen.
    screenReaderOnly: ["modalLabel", "close", "loading", "frameTitle"].includes(e.key),
  })),
};

let screens = 0;
let lines = 0;
for (const screen of [...bookerCopyScreens(), embedScreen, ...inviteCopyScreens()]) {
  screens++;
  console.log(`\n${"=".repeat(78)}`);
  console.log(screen.screen);
  console.log(`why: ${screen.purpose}`);
  for (const line of screen.lines) {
    lines++;
    const tag = line.screenReaderOnly ? " (heard, not seen)" : "";
    console.log(`\n  -- ${line.state}${tag}`);
    for (const part of line.text.split("\n")) console.log(`     ${part}`);
  }
}
console.log(`\n${"=".repeat(78)}`);
console.log(`${lines} lines of lead-facing copy across ${screens} screens.`);
