// Print the `label:hash` entry for a retired booking API key (#2879), for the
// BOOKING_API_RETIRED_KEY_HASHES Worker secret. Run:
//   pnpm -s hash:retired-key <label>
//
// The key is read from RETIRED_BOOKING_API_KEY (put it in .env.local, which this
// loads), never from an argument, so it never reaches the shell history or a
// transcript. Only the label and the hash are printed, on one line, so the output
// can be piped straight into `npx wrangler secret put BOOKING_API_RETIRED_KEY_HASHES`.
// Delete the line from .env.local afterwards.
//
// Several retired keys go in ONE secret, comma separated; this prints one entry.
import { retiredKeyHashLine } from "../src/lib/booking/retired-keys.ts";

const label = process.argv[2] ?? "";
const key = process.env.RETIRED_BOOKING_API_KEY ?? "";
if (!label) {
  process.stderr.write("usage: pnpm -s hash:retired-key <label>, with RETIRED_BOOKING_API_KEY set in .env.local\n");
  process.exit(1);
}
try {
  process.stdout.write(`${await retiredKeyHashLine(label, key)}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
