// Where the list of retired booking key hashes is kept in the repo (#2879).
//
// The Worker reads the list from the BOOKING_API_RETIRED_KEY_HASHES secret, and a
// secret can be neither read back nor appended to: `wrangler secret put` replaces
// it whole. So the list lives here too, one `label:sha256:<hash>` entry per line
// under a `#` header. Hashes are not secret.
//
// The path is resolved from THIS file's location, never the working directory, so
// running the command from anywhere reads and writes the repo's own list.
// RETIRED_KEY_HASHES_PATH overrides it, and exists so the suite can drive the real
// command against a temporary file instead of the committed one.
import { fileURLToPath } from "node:url";

export function retiredKeyHashesPath(): string {
  const override = process.env.RETIRED_KEY_HASHES_PATH?.trim();
  if (override) return override;
  return fileURLToPath(new URL("../../docs/retired-booking-key-hashes.txt", import.meta.url));
}
