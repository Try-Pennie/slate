// The Pennie logo the reminder's contact card carries when the advisor has no photo
// (#2980). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pennie-card-logo.ts
//
// It is bundled as a constant, so nothing checks it at send time: this is where it
// is proved to be a real, small, square, opaque image of the type the card declares.
// A truncated paste or a transparent PNG would otherwise ship silently and show as a
// broken or black contact picture on the lead's phone.
import { PENNIE_CARD_LOGO } from "../src/lib/booking/pennie-card-logo.ts";
import { CARD_PHOTO_MAX_BYTES, CARD_PHOTO_SIZE_PX } from "../src/lib/booking/advisor-card-photo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const bytes = Buffer.from(PENNIE_CARD_LOGO.base64, "base64");

eq(PENNIE_CARD_LOGO.type, "PNG", "declared a PNG");
assert(
  bytes.toString("base64") === PENNIE_CARD_LOGO.base64,
  "the constant is clean base64, so it round trips with nothing dropped or added",
);
eq(
  [...bytes.subarray(0, 8)],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "and really is a PNG, by its signature",
);
eq(bytes.subarray(12, 16).toString("ascii"), "IHDR", "with its header where PNG puts it");
eq(bytes.readUInt32BE(16), CARD_PHOTO_SIZE_PX, "as wide as an advisor photo is asked to be");
eq(bytes.readUInt32BE(20), CARD_PHOTO_SIZE_PX, "and square, so the contact circle crops it evenly");
// Colour type 2 is RGB with no alpha channel. A transparent background reads as black
// in an iPhone contact circle, so the logo must sit on a solid one.
eq(bytes[25], 2, "opaque RGB, no transparency");
eq(bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii"), "IEND", "and complete, ending on IEND");
assert(bytes.length < CARD_PHOTO_MAX_BYTES, `inside the card's photo cap (${bytes.length} bytes)`);
assert(bytes.length < 16 * 1024, `and small enough to add next to nothing to the email (${bytes.length} bytes)`);

finish();
