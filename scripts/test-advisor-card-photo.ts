// The advisor's photo for the reminder's contact card (#1334, #3027). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-card-photo.ts
//
// The bytes come from `advisor_photos`, and they are checked again here rather than
// trusted: the card declares a type and a phone believes it. Every way a stored
// value can be wrong must end in "no photo" with a reason, never a broken card.
import { CARD_PHOTO_MAX_BYTES, cardPhotoFromStored } from "../src/lib/booking/advisor-card-photo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

{
  const got = cardPhotoFromStored({ base64: b64(JPEG), mime: "image/jpeg" });
  eq(got.ok && got.photo.type, "JPEG", "a stored JPEG is a JPEG card photo");
  eq(got.ok && got.photo.base64, b64(JPEG), "carrying the stored bytes unchanged");
  const png = cardPhotoFromStored({ base64: b64(PNG), mime: "image/png" });
  eq(png.ok && png.photo.type, "PNG", "a stored PNG is a PNG card photo");
}

const refusals: [string, { base64: string; mime: string }, string][] = [
  ["a type the card cannot carry", { base64: b64(JPEG), mime: "image/gif" }, "not an image the card can carry"],
  ["no type at all", { base64: b64(JPEG), mime: "" }, "no type"],
  ["bytes that disagree with the label", { base64: b64(PNG), mime: "image/jpeg" }, "does not match"],
  ["bytes that are no image", { base64: b64(new Uint8Array([1, 2, 3])), mime: "image/png" }, "does not match"],
  ["a value that is not base64", { base64: "!!!", mime: "image/jpeg" }, "not readable base64"],
  ["an empty value", { base64: "", mime: "image/jpeg" }, "not readable base64"],
];
for (const [label, row, reason] of refusals) {
  const got = cardPhotoFromStored(row);
  assert(!got.ok, `${label} is refused`);
  assert(!got.ok && got.reason.includes(reason), `${label}: the reason says "${reason}"`);
}

{
  const big = new Uint8Array(CARD_PHOTO_MAX_BYTES + 1);
  big.set(JPEG);
  const got = cardPhotoFromStored({ base64: b64(big), mime: "image/jpeg" });
  assert(!got.ok && got.reason.includes("too large"), "one byte over the ceiling is refused");
  const fits = new Uint8Array(CARD_PHOTO_MAX_BYTES);
  fits.set(JPEG);
  assert(cardPhotoFromStored({ base64: b64(fits), mime: "image/jpeg" }).ok, "exactly at the ceiling is accepted");
}

finish();
