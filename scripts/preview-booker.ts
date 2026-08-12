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
import { bookerCopyScreens } from "../src/lib/booking/copy-preview.ts";

let screens = 0;
let lines = 0;
for (const screen of bookerCopyScreens()) {
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
