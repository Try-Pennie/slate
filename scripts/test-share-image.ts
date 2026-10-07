// The picture a pasted Slate link unfurls with.
//
// A link to the booker or the manage page pasted into Slack or a text used to
// unfurl with a grey "no image" placeholder, because nothing set og:image. The
// root layout's `openGraph.images` names a plain file under `public/`, not Next's
// `opengraph-image.png` convention, because Slack caches the picture by its URL
// and a changed picture under the convention kept unfurling as the old one. It
// has three ways to ship broken that no other test sees:
//
//   - the image is the wrong shape. Slack and iMessage crop a card to about
//     1.91:1, so anything else is cut into.
//   - the layout names a file that is not there, or the convention file comes
//     back and competes with it.
//   - `metadataBase` is missing from the root layout. og:image must be an
//     absolute URL, and without a base Next fills in localhost, which every
//     crawler then fails to fetch: the same grey placeholder, on a page whose
//     markup looks correct.
//
// Run: node --experimental-strip-types scripts/test-share-image.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const URL_PATH = "/brand/share-pennie-mark.png";
const IMAGE = `public${URL_PATH}`;
const LAYOUT = "src/app/layout.tsx";

/** Width and height from a PNG's IHDR chunk, or null for anything that is not a PNG. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Positive control: the reader must be able to say no.
eq(pngSize(Buffer.from("not a png at all, just some text")), null, "pngSize refuses a non PNG");

assert(existsSync(join(root, IMAGE)), `${IMAGE} exists`);
const size = pngSize(readFileSync(join(root, IMAGE)));
eq(size, { width: 1200, height: 630 }, `${IMAGE} is 1200x630, the shape link cards crop to`);

const layout = readFileSync(join(root, LAYOUT), "utf8");
assert(
  new RegExp(`images:\\s*\\[\\{\\s*url:\\s*"${URL_PATH.replace(/[./]/g, "\\$&")}",\\s*width:\\s*1200,\\s*height:\\s*630,\\s*alt:\\s*"[^"]+"`).test(layout),
  `${LAYOUT} names ${URL_PATH} as og:image, 1200x630, with alt text`,
);
assert(
  !existsSync(join(root, "src/app/opengraph-image.png")) && !existsSync(join(root, "src/app/opengraph-image.jpg")),
  "no opengraph-image convention file competes with the layout's og:image",
);

assert(
  /metadataBase:\s*new URL\(\s*"https:\/\/slate\.trypennie\.app"\s*\)/.test(layout),
  `${LAYOUT} sets metadataBase to the production origin, or og:image resolves to localhost`,
);

finish();
