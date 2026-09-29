// Print the `label:sha256:<hash>` entry for a retired booking API key (#2879), for the
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
// A key still configured in a live booking key slot here is refused, since it is
// not retired and its hash would never fire.
import { retiredKeyHashLine } from "../src/lib/booking/retired-keys.ts";
import { BOOKING_API_CALLERS, bookingApiKeyEnvName } from "../src/lib/booking/api-auth.ts";

const label = process.argv[2] ?? "";
const key = process.env.RETIRED_BOOKING_API_KEY ?? "";
if (!label) {
  process.stderr.write("usage: pnpm -s hash:retired-key <label>, with RETIRED_BOOKING_API_KEY set in .env.local\n");
  process.exit(1);
}
try {
  // Every booking key configured here (.env.local), so a key still in a live slot is
  // refused: it authenticates, so the watcher would never see it. The Worker checks
  // the same against its own slots, which this machine may not hold.
  const live = BOOKING_API_CALLERS.flatMap((caller) =>
    (["primary", "secondary"] as const).map((slot) => ({
      id: `${caller}:${slot}`,
      secret: process.env[bookingApiKeyEnvName(caller, slot)] ?? "",
    })),
  ).filter((k) => k.secret.trim() !== "");
  process.stdout.write(`${await retiredKeyHashLine(label, key, live)}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
